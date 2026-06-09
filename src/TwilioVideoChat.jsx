import { Component, createElement, createRef } from "react";
import { hot } from "react-hot-loader/root";
import Video from "twilio-video"; // Modernized standard ES6 import

import "./ui/TwilioVideoChat.css";
import { buildWidgetEvent, emitWidgetEvent } from "./services/eventLogger";
import { performDeviceCheck } from "./services/deviceService";
import {
  WIDGET_VERSION,
  WIDGET_FEATURES,
  TWILIO_SDK_VERSION
} from "./version";

class TwilioVideoChat extends Component {
  constructor(props) {
    super(props);

    this.state = {
      connectionState: "Disconnected", // Disconnected, Connecting, Preview, Connected
      isMicrophoneMuted: false,
      isCameraMuted: false,
      participantCount: 0
    };

    // Safe DOM Targets using React Refs
    this.localMediaRef = createRef();
    this.remoteMediaRef = createRef();
    this.logRef = createRef();

    // Instance Management
    this._isMounted = false;
    this.instanceId = Math.random().toString(36).substr(2, 9);
    this.activeRoom = null;
    this.localTracks = [];
    this.participantContainers = new Map(); // Upgraded to Map for safer memory collection
    this.connectionInProgress = false;
    this.eventListeners = [];
  }

  componentDidMount() {
    this._isMounted = true;
    
    // Register event listeners safely
    this.registerEventListener(window, 'beforeunload', () => this.leaveRoom());
    this.registerEventListener(window, 'blur', () => this.handleFocusLost());
    this.registerEventListener(window, 'focus', () => this.handleFocusReturned());
    this.registerEventListener(document, 'visibilitychange', () => {
      if (document.hidden) {
        this.handleFocusLost();
      } else {
        this.handleFocusReturned();
      }
    });

    // Handle initial state expressions passed on widget load
    if (this.props.joinRoomActiveExpr?.value && !this.connectionInProgress) {
      this.joinRoom();
    } else if (this.props.previewActiveExpr?.value) {
      this.showPreview();
    }
  }

  componentWillUnmount() {
    this._isMounted = false;

    // Flush active bindings to completely eliminate closures leak
    this.eventListeners.forEach(({ target, event, handler }) => {
      target.removeEventListener(event, handler);
    });
    this.eventListeners = [];

    this.leaveRoom();
  }

  registerEventListener(target, event, handler) {
    target.addEventListener(event, handler);
    this.eventListeners.push({ target, event, handler });
  }

  componentDidUpdate(prevProps) {
    const prevJoinRoom = prevProps.joinRoomActiveExpr?.value;
    const currentJoinRoom = this.props.joinRoomActiveExpr?.value;
    const prevPreview = prevProps.previewActiveExpr?.value;
    const currentPreview = this.props.previewActiveExpr?.value;

    // Guard evaluation tracks against historical primitives instead of mutable triggers
    if (currentJoinRoom !== prevJoinRoom) {
      if (currentJoinRoom && !this.activeRoom && !this.connectionInProgress) {
        this.joinRoom();
      } else if (!currentJoinRoom && (this.activeRoom || this.connectionInProgress)) {
        this.leaveRoom();
      }
    }

    if (currentPreview !== prevPreview && !this.activeRoom) {
      if (currentPreview && this.localTracks.length === 0) {
        this.showPreview();
      } else if (!currentPreview) {
        this.hidePreview();
      }
    }
  }

  log(message) {
    const { logActiveExpr } = this.props;
    if (logActiveExpr && logActiveExpr.value) {
      const logElement = this.logRef.current;
      if (logElement) {
        const p = document.createElement('p');
        p.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
        logElement.appendChild(p);

        logElement.scrollTop = logElement.scrollHeight;
        while (logElement.childNodes.length > 100) {
          logElement.removeChild(logElement.firstChild);
        }
      }
    }
  }

  updateConnectionState() {
    if (!this._isMounted) return;

    let connectionState = "Disconnected";
    if (this.connectionInProgress) {
      connectionState = "Connecting";
    } else if (this.activeRoom) {
      connectionState = "Connected";
    } else if (this.localTracks.length > 0) {
      connectionState = "Preview";
    }

    this.setState({ connectionState });
  }

  toggleMicrophone() {
    if (!this.activeRoom?.localParticipant) {
      this.log("Cannot toggle microphone: not connected to room");
      return;
    }

    try {
      const audioTrackPub = Array.from(this.activeRoom.localParticipant.audioTracks.values())[0];
      if (!audioTrackPub?.track) {
        this.log("No audio track available to mute");
        return;
      }

      const shouldMute = !this.state.isMicrophoneMuted;
      if (shouldMute) {
        audioTrackPub.track.disable();
        this.setState({ isMicrophoneMuted: true });
        this.log("Microphone muted");
      } else {
        audioTrackPub.track.enable();
        this.setState({ isMicrophoneMuted: false });
        this.log("Microphone unmuted");
      }

      this.sendWidgetEvent("MICROPHONE_TOGGLED", "INFO", `Microphone state changed`, { isMuted: shouldMute });
    } catch (e) {
      this.handleError("Error toggling microphone", e);
    }
  }

  toggleCamera() {
    if (!this.activeRoom?.localParticipant) {
      this.log("Cannot toggle camera: not connected to room");
      return;
    }

    try {
      const videoTrackPub = Array.from(this.activeRoom.localParticipant.videoTracks.values())[0];
      if (!videoTrackPub?.track) {
        this.log("No video track available to mute");
        return;
      }

      const shouldMute = !this.state.isCameraMuted;
      if (shouldMute) {
        videoTrackPub.track.disable();
        this.setState({ isCameraMuted: true });
        this.log("Camera disabled");
      } else {
        videoTrackPub.track.enable();
        this.setState({ isCameraMuted: false });
        this.log("Camera enabled");
      }

      this.sendWidgetEvent("CAMERA_TOGGLED", "INFO", `Camera state changed`, { isMuted: shouldMute });
    } catch (e) {
      this.handleError("Error toggling camera", e);
    }
  }

  sendWidgetEvent(eventType, eventLevel, message, details = {}) {
    const { roomNameExpr, nickNameExpr, participantSide, eventJsonAttribute, onWidgetEvent, logActiveExpr } = this.props;

    const payload = buildWidgetEvent({
      eventType,
      eventLevel,
      sessionId: roomNameExpr?.value || "",
      participantIdentity: nickNameExpr?.value || "",
      participantSide: participantSide || "",
      message,
      details
    });

    emitWidgetEvent({
      eventJsonAttribute,
      onWidgetEvent,
      payload,
      logMessages: logActiveExpr && logActiveExpr.value
    });
  }

  getIntegerProp(propName, defaultValue) {
    const prop = this.props[propName];
    if (!prop || prop.value === undefined || prop.value === null) return defaultValue;
    const parsedValue = parseInt(prop.value, 10);
    return isNaN(parsedValue) ? defaultValue : parsedValue;
  }

  getBooleanProp(propName, defaultValue) {
    const prop = this.props[propName];
    if (!prop || prop.value === undefined || prop.value === null) return defaultValue;
    return prop.value;
  }

  isAgentParticipant() {
    return this.props.participantSide === "agent";
  }

  clearPreviewContainer() {
    const previewContainer = this.localMediaRef.current;
    if (previewContainer) {
      while (previewContainer.firstChild) {
        previewContainer.removeChild(previewContainer.firstChild);
      }
    }
  }

  stopLocalTracks() {
    if (this.localTracks && this.localTracks.length > 0) {
      this.localTracks.forEach(track => {
        try {
          track.detach().forEach(el => el.remove());
          if (typeof track.stop === "function") track.stop();
        } catch (e) {
          console.error("Error completely stopping local track", e);
        }
      });
    }
    this.localTracks = [];
    this.clearPreviewContainer();
  }

  attachTrack(track, container) {
    if (!track || !container || typeof track.attach !== "function") return;
    try {
      const attachedElement = track.attach();
      // Guard against duplicating DOM attachments
      if (!container.contains(attachedElement)) {
        container.appendChild(attachedElement);
      }
    } catch (e) {
      console.error("Error tracking DOM attach node", e);
    }
  }

  detachTrack(track) {
    if (!track || typeof track.detach !== "function") return;
    try {
      track.detach().forEach(element => element?.remove());
    } catch (e) {
      console.error("Error executing safe detach track track node", e);
    }
  }

  async joinRoom() {
    const { roomNameExpr, nickNameExpr, accessTokenExpr } = this.props;
    const roomName = roomNameExpr?.value;
    const identity = nickNameExpr?.value;
    const token = accessTokenExpr?.value;

    if (!roomName || !identity || !token) {
      this.log("Missing authentication properties validation schema aborting");
      return;
    }

    if (this.connectionInProgress) return;

    this.connectionInProgress = true;
    this.updateConnectionState();

    const isAgent = this.isAgentParticipant();
    const defaultMedia = !isAgent;
    const audioEnabled = this.getBooleanProp("microphoneEnabledExpr", defaultMedia);
    const videoEnabled = this.getBooleanProp("cameraEnabledExpr", defaultMedia);
    const videoWidth = this.getIntegerProp("videoWidth", 640);
    const videoHeight = this.getIntegerProp("videoHeight", 480);

    const connectOptions = { name: roomName, logLevel: "warn", tracks: [] };

    if (isAgent) {
      this.log("Agent joining session. Hardware access initialization skipped.");
      try {
        const room = await Video.connect(token, connectOptions);
        if (!this._isMounted) {
          room.disconnect();
          return;
        }
        this.roomJoined(room, identity);
      } catch (error) {
        this.handleError("Agent connection sequence failed", error);
      }
      return;
    }

    // Customer hardware onboarding line execution
    try {
      const deviceCheckResult = await performDeviceCheck({ requireCamera: false, requireMicrophone: false });
      let finalAudio = audioEnabled && deviceCheckResult.success;
      let finalVideo = videoEnabled && deviceCheckResult.success;

      if (finalAudio || finalVideo) {
        try {
          this.localTracks = await Video.createLocalTracks({
            audio: finalAudio,
            video: finalVideo ? { width: videoWidth, height: videoHeight } : false
          });
        } catch (err) {
          this.log("Hardware profiles busy or blocked by sandbox permissions, dropping media hardware layer");
          this.localTracks = [];
        }
      }

      if (!this._isMounted) {
        this.stopLocalTracks();
        return;
      }

      connectOptions.tracks = this.localTracks;
      const room = await Video.connect(token, connectOptions);
      this.roomJoined(room, identity);
    } catch (error) {
      this.handleError("Customer room handshaking sequence failed", error);
    }
  }

  async showPreview() {
    if (this.isAgentParticipant() || !this.getBooleanProp("cameraEnabledExpr", true)) return;

    const videoWidth = this.getIntegerProp("videoWidth", 640);
    const videoHeight = this.getIntegerProp("videoHeight", 480);

    try {
      this.stopLocalTracks(); // Wipe stale preview context configurations
      
      this.localTracks = await Video.createLocalTracks({
        audio: false,
        video: { width: videoWidth, height: videoHeight }
      });

      if (!this._isMounted) {
        this.stopLocalTracks();
        return;
      }

      const container = this.localMediaRef.current;
      if (container) {
        this.localTracks.forEach(track => this.attachTrack(track, container));
      }
      this.updateConnectionState();
    } catch (error) {
      this.log(`Preview window creation runtime failure: ${error?.message}`);
    }
  }

  hidePreview() {
    if (!this.activeRoom) {
      this.stopLocalTracks();
    } else {
      this.clearPreviewContainer();
    }
    this.updateConnectionState();
  }

  leaveRoom() {
    this.connectionInProgress = false;

    if (this.activeRoom) {
      try {
        this.activeRoom.disconnect();
      } catch (e) {
        console.error("Error executing safe teardown sequence", e);
      }
      this.activeRoom = null;
    }

    this.stopLocalTracks();
    
    if (this.remoteMediaRef.current) {
      this.remoteMediaRef.current.innerHTML = "";
    }
    
    this.participantContainers.clear();
    this.updateConnectionState();
  }

  roomJoined(room, identity) {
    this.activeRoom = room;
    this.connectionInProgress = false;
    
    this.setState({
      isMicrophoneMuted: false,
      isCameraMuted: false,
      participantCount: room.participants.size
    }, () => this.updateConnectionState());

    this.log(`Successfully connected inside room session as: ${identity}`);
    
    const remoteContainer = this.remoteMediaRef.current;
    const localContainer = this.localMediaRef.current;

    // Attach local camera feed inside DOM reference if elements exist
    if (localContainer && this.localTracks.length > 0) {
      this.localTracks.forEach(track => this.attachTrack(track, localContainer));
    }

    // Map existing remote participants inside room context topology
    room.participants.forEach(participant => {
      this.handleParticipantConnected(participant, remoteContainer);
    });

    // Subscribed Event Track Listeners
    room.on('participantConnected', (participant) => {
      this.log(`Remote pipeline connected: ${participant.identity}`);
      this.handleParticipantConnected(participant, remoteContainer);
      this.setState({ participantCount: this.activeRoom.participants.size });
    });

    room.on('participantDisconnected', (participant) => {
      this.log(`Remote participant left: ${participant.identity}`);
      this.handleParticipantDisconnected(participant);
      this.setState({ participantCount: this.activeRoom.participants.size });
    });

    room.once('disconnected', () => {
      this.leaveRoom();
    });
  }

  handleParticipantConnected(participant, container) {
    if (!container || !this._isMounted) return;

    // Remove old wrappers if matching key collisions occur
    if (this.participantContainers.has(participant.identity)) {
      this.handleParticipantDisconnected(participant);
    }

    const pContainer = document.createElement('div');
    pContainer.className = 'participant-container';
    
    const tracksContainer = document.createElement('div');
    tracksContainer.className = 'participant-tracks';
    
    const nameLabel = document.createElement('div');
    nameLabel.className = 'participant-name';
    nameLabel.textContent = participant.identity;

    pContainer.appendChild(tracksContainer);
    pContainer.appendChild(nameLabel);
    container.appendChild(pContainer);

    this.participantContainers.set(participant.identity, pContainer);

    const trackSubscribed = (track) => this.attachTrack(track, tracksContainer);
    const trackUnsubscribed = (track) => this.detachTrack(track);

    participant.tracks.forEach(pub => {
      if (pub.isSubscribed) trackSubscribed(pub.track);
    });

    participant.on('trackSubscribed', trackSubscribed);
    participant.on('trackUnsubscribed', trackUnsubscribed);
  }

  handleParticipantDisconnected(participant) {
    const container = this.participantContainers.get(participant.identity);
    if (container) {
      container.remove();
      this.participantContainers.delete(participant.identity);
    }
    participant.removeAllListeners();
  }

  handleError(message, error) {
    this.connectionInProgress = false;
    this.leaveRoom();
    this.log(`${message}: ${error?.message || "Unknown Exception Error Context"}`);
    
    this.sendWidgetEvent("FATAL_ERROR", "ERROR", message, {
      errorMessage: error?.message || ""
    });
  }

  handleFocusLost() {
    this.log("Focus context minimized out of browser horizon");
    this.sendWidgetEvent("FOCUS_LOST", "WARNING", "App interface context shifted target out of focal view");
  }

  handleFocusReturned() {
    this.log("Focus target interactive scope regained");
    this.sendWidgetEvent("FOCUS_RETURNED", "INFO", "Interface view restored active state context");
  }

  render() {
    const { showDiagnostics, showFeatureList, participantSide } = this.props;
    const { connectionState, isMicrophoneMuted, isCameraMuted, participantCount } = this.state;
    const isConnected = connectionState === "Connected";
    const isPreview = connectionState === "Preview";

    return (
      <div className="twilio-video">
        <div className="twilio-controls">
          <div className={`twilio-status-indicator ${connectionState.toLowerCase()}`}>
            <span className="twilio-status-dot"></span>
            <span className="twilio-status-text">
              {isConnected ? `Connected (${participantCount} Peer${participantCount === 1 ? '' : 's'})` : connectionState}
            </span>
          </div>

          {isConnected && (
            <div className="twilio-media-controls">
              <button
                className={`twilio-control-btn twilio-microphone-btn ${isMicrophoneMuted ? 'muted' : 'active'}`}
                onClick={() => this.toggleMicrophone()}
              >
                <span className="twilio-icon">{isMicrophoneMuted ? '🔇' : '🎤'}</span>
                <span className="twilio-label">{isMicrophoneMuted ? 'Muted' : 'Mic'}</span>
              </button>

              <button
                className={`twilio-control-btn twilio-camera-btn ${isCameraMuted ? 'muted' : 'active'}`}
                onClick={() => this.toggleCamera()}
              >
                <span className="twilio-icon">{isCameraMuted ? '❌📹' : '📹'}</span>
                <span className="twilio-label">{isCameraMuted ? 'Off' : 'Camera'}</span>
              </button>
            </div>
          )}
        </div>

        {/* Explicitly managed layouts bound inside UI element structures directly via Refs */}
        <div ref={this.remoteMediaRef} className="media remote-media" style={{ display: isConnected ? "flex" : "none" }}></div>
        <div ref={this.localMediaRef} className="media local-media" style={{ display: (isPreview || isConnected) ? "block" : "none" }}></div>

        <div ref={this.logRef} className="log"></div>

        {showDiagnostics && (
          <div className="twilio-diagnostics">
            <div><strong>ISR Secure Video Platform</strong></div>
            <div>Widget Environment: {WIDGET_VERSION}</div>
            <div>Topology Node Assignment: {participantSide}</div>
            <div>State Context Engine: {connectionState}</div>
            <div>Core Twilio Integration Bundle: {TWILIO_SDK_VERSION}</div>
          </div>
        )}
      </div>
    );
  }
}

export default hot(TwilioVideoChat);