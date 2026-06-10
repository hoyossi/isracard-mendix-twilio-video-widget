import React, { Component, createElement, createRef } from "react";
import { hot } from "react-hot-loader/root";
import Video from "twilio-video";

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
      participantCount: 0,
      showLogs: true 
    };

    this.localMediaRef = createRef();
    this.remoteMediaRef = createRef();
    this.logRef = createRef();

    this._isMounted = false;
    this.instanceId = Math.random().toString(36).substr(2, 9);
    this.activeRoom = null;
    this.localTracks = [];
    this.localDataTrack = null; 
    this.participantContainers = new Map();
    this.connectionInProgress = false;
    this.eventListeners = [];
  }

  componentDidMount() {
    this._isMounted = true;
    
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

    this.evaluateIncomingProps();
  }

  componentWillUnmount() {
    this._isMounted = false;
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
    this.evaluateIncomingProps(prevProps);
  }

  evaluateIncomingProps(prevProps = null) {
    const currentJoinRoom = this.props.joinRoomActiveExpr?.value;
    const currentPreview = this.props.previewActiveExpr?.value;

    const token = this.props.accessTokenExpr?.value;
    const roomName = this.props.roomNameExpr?.value;
    const identity = this.props.nickNameExpr?.value;

    if (currentJoinRoom) {
      if (!this.activeRoom && !this.connectionInProgress && token && roomName && identity) {
        this.joinRoom();
      }
    } else {
      if (this.activeRoom || this.connectionInProgress || this.localTracks.length > 0) {
        const prevJoinRoom = prevProps?.joinRoomActiveExpr?.value;
        if (prevJoinRoom === true || prevJoinRoom === undefined) {
          this.leaveRoom();
        }
      }
    }

    if (!currentJoinRoom && !this.isAgentParticipant()) {
      const prevPreview = prevProps?.previewActiveExpr?.value;
      if (currentPreview !== prevPreview) {
        if (currentPreview) {
          this.showPreview();
        } else {
          this.hidePreview();
        }
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

  toggleMicrophone(forceState = null) {
    if (!this.activeRoom?.localParticipant) return;
    try {
      const audioTrackPub = Array.from(this.activeRoom.localParticipant.audioTracks.values())[0];
      if (!audioTrackPub?.track) return;

      const shouldMute = forceState !== null ? !forceState : !this.state.isMicrophoneMuted;
      if (shouldMute) {
        audioTrackPub.track.disable();
        this.setState({ isMicrophoneMuted: true });
        this.log("Microphone muted via administrative override directive.");
      } else {
        audioTrackPub.track.enable();
        this.setState({ isMicrophoneMuted: false });
        this.log("Microphone unmuted via administrative override directive.");
      }
    } catch (e) {
      this.handleError("Error modifying microphone track state", e);
    }
  }

  toggleCamera(forceState = null) {
    if (!this.activeRoom?.localParticipant) return;
    
    try {
      const videoTrackPub = Array.from(this.activeRoom.localParticipant.videoTracks.values())[0];
      const shouldMute = forceState !== null ? !forceState : !this.state.isCameraMuted;
      
      if (shouldMute) {
        if (videoTrackPub?.track) {
          videoTrackPub.track.disable();
          videoTrackPub.track.stop();
        }
        this.setState({ isCameraMuted: true });
        this.log("Webcam hardware streams cleanly stopped.");
      } else {
        const videoWidth = this.getIntegerProp("videoWidth", 640);
        const videoHeight = this.getIntegerProp("videoHeight", 480);
        
        Video.createLocalVideoTrack({ width: videoWidth, height: videoHeight }).then(newTrack => {
          if (!this._isMounted || !this.activeRoom) {
            newTrack.stop();
            return;
          }
          
          this.localTracks = this.localTracks.filter(t => t.kind !== 'video');
          this.localTracks.push(newTrack);

          if (videoTrackPub?.track) {
            this.activeRoom.localParticipant.unpublishTrack(videoTrackPub.track);
            videoTrackPub.track.detach().forEach(el => el.remove());
          }
          
          this.activeRoom.localParticipant.publishTrack(newTrack);
          this.setState({ isCameraMuted: false });
          
          const localContainer = this.localMediaRef.current;
          if (localContainer) {
            while (localContainer.firstChild) {
              localContainer.removeChild(localContainer.firstChild);
            }
            this.attachTrack(newTrack, localContainer);
          }
          this.log("Webcam hardware streams successfully unmuted and re-published.");
        });
      }
    } catch (e) {
      this.handleError("Error executing camera override track transaction", e);
    }
  }

  sendRemoteControlCommand(commandName, targetValue) {
    if (!this.isAgentParticipant()) return;
    
    if (this.localDataTrack) {
      const payload = JSON.stringify({ command: commandName, value: targetValue });
      this.localDataTrack.send(payload);
      this.log(`Dispatched remote payload command: ${commandName} -> ${targetValue}`);
    } else {
      this.log("Command rejected: WebRTC Signaling Data Track is offline.");
    }
  }

  captureCustomerScreenshot() {
    if (!this.isAgentParticipant() || !this.remoteMediaRef.current) return;

    try {
      const videoEl = this.remoteMediaRef.current.querySelector("video");
      if (!videoEl) {
        this.log("Screenshot aborted: No active customer stream rendering on canvas.");
        return;
      }

      const canvas = document.createElement("canvas");
      canvas.width = videoEl.videoWidth || 640;
      canvas.height = videoEl.videoHeight || 480;

      const ctx = canvas.getContext("2d");
      ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);

      const base64Data = canvas.toDataURL("image/png");
      this.log("Customer validation frame captured successfully.");

      this.sendWidgetEvent("SCREENSHOT_CAPTURED", "INFO", "Customer verification snapshot data compiled.", {
        screenshotDataURI: base64Data
      });
    } catch (err) {
      this.log(`Verification snapshot generation failure: ${err?.message}`);
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
          if (typeof track.stop === "function") {
            track.stop(); 
          }
        } catch (e) {
          console.error("Error stopping local media track clone", e);
        }
      });
    }
    this.localTracks = [];

    if (this.activeRoom?.localParticipant) {
      try {
        this.activeRoom.localParticipant.tracks.forEach(pub => {
          if (pub.track && pub.kind !== 'data') {
            pub.track.detach().forEach(el => el.remove());
            if (typeof pub.track.stop === "function") pub.track.stop();
          }
        });
      } catch (err) {
        console.error("Trace track breakdown array exception", err);
      }
    }
    this.clearPreviewContainer();
  }

  attachTrack(track, container) {
    if (!track || !container || typeof track.attach !== "function") return;
    try {
      const attachedElement = track.attach();
      if (!container.contains(attachedElement)) {
        container.appendChild(attachedElement);
      }
    } catch (e) {
      console.error("DOM Node media track appending failed", e);
    }
  }

  detachTrack(track) {
    if (!track || typeof track.detach !== "function") return;
    try {
      track.detach().forEach(element => element?.remove());
    } catch (e) {
      console.error("Clean track element removal trace exception", e);
    }
  }

  async joinRoom() {
    const { roomNameExpr, nickNameExpr, accessTokenExpr } = this.props;
    const roomName = roomNameExpr?.value;
    const identity = nickNameExpr?.value;
    const token = accessTokenExpr?.value;

    if (!roomName || !identity || !token) {
      this.connectionInProgress = false;
      this.updateConnectionState();
      return;
    }

    if (this.connectionInProgress) return;

    this.connectionInProgress = true;
    this.updateConnectionState();

    const isAgent = this.isAgentParticipant();
    const videoWidth = this.getIntegerProp("videoWidth", 640);
    const videoHeight = this.getIntegerProp("videoHeight", 480);

    this.localDataTrack = new Video.LocalDataTrack();
    const connectOptions = { name: roomName, logLevel: "warn", tracks: [this.localDataTrack] };

    if (isAgent) {
      this.log("Agent session initialization routing active.");
      try {
        const room = await Video.connect(token, connectOptions);
        if (!this._isMounted) {
          room.disconnect();
          return;
        }
        this.roomJoined(room, identity);
      } catch (error) {
        this.handleError("Agent console signaling bridge registration failure", error);
      }
      return;
    }

    try {
      const deviceCheckResult = await performDeviceCheck({ requireCamera: false, requireMicrophone: false });
      this.stopLocalTracks(); 

      if (deviceCheckResult.success) {
        try {
          this.localTracks = await Video.createLocalTracks({
            audio: true,
            video: { width: videoWidth, height: videoHeight }
          });
        } catch (err) {
          this.log("Webcam drivers blocked by operating system sandbox policies.");
          this.localTracks = [];
        }
      }

      if (!this._isMounted) {
        this.stopLocalTracks();
        return;
      }

      connectOptions.tracks = [this.localDataTrack, ...this.localTracks];
      const room = await Video.connect(token, connectOptions);
      this.roomJoined(room, identity);
    } catch (error) {
      this.handleError("Customer room handshake initialization failure", error);
    }
  }

  roomJoined(room, identity) {
    this.activeRoom = room;
    this.connectionInProgress = false;
    
    this.setState({
      isMicrophoneMuted: false,
      isCameraMuted: false,
      participantCount: room.participants.size
    }, () => this.updateConnectionState());

    this.log(`Successfully connected inside validation session room. Client identity: ${identity}`);
    
    const remoteContainer = this.remoteMediaRef.current;
    const localContainer = this.localMediaRef.current;

    if (localContainer && this.localTracks.length > 0 && !this.isAgentParticipant()) {
      this.localTracks.forEach(track => {
        if (track.kind !== 'data') this.attachTrack(track, localContainer);
      });
    }

    room.participants.forEach(participant => {
      this.handleParticipantConnected(participant, remoteContainer);
    });

    room.on('participantConnected', (participant) => {
      this.log(`Remote verification branch linked: ${participant.identity}`);
      this.handleParticipantConnected(participant, remoteContainer);
      this.setState({ participantCount: this.activeRoom.participants.size });
    });

    room.on('participantDisconnected', (participant) => {
      this.log(`Remote verification branch offline: ${participant.identity}`);
      this.handleParticipantDisconnected(participant);
      this.setState({ participantCount: this.activeRoom.participants.size });
    });

    room.once('disconnected', () => {
      this.leaveRoom();
    });
  }

  handleParticipantConnected(participant, container) {
    if (!container || !this._isMounted) return;

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

    const trackSubscribed = (track) => {
      if (track.kind === 'data') {
        track.on('message', (data) => {
          try {
            const parsed = JSON.parse(data);
            this.log(`Decoded real-time signaling transaction directive: ${parsed.command}`);
            
            if (!this.isAgentParticipant()) {
              if (parsed.command === "SET_CAMERA") {
                this.toggleCamera(parsed.value);
              }
              if (parsed.command === "SET_MICROPHONE") {
                this.toggleMicrophone(parsed.value);
              }
              if (parsed.command === "TERMINATE_SESSION") {
                this.log("Agent closed the current call session. Leaving room safely.");
                this.leaveRoom();
              }
            }
          } catch (err) {
            console.error("Signaling frame parsing crash trace exception:", err);
          }
        });
      } else {
        if (this.isAgentParticipant()) {
          this.attachTrack(track, tracksContainer);
        }
      }
    };

    const trackUnsubscribed = (track) => {
      if (track.kind !== 'data') this.detachTrack(track);
    };

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
    this.log(`${message}: ${error?.message || "Unknown Exception Instance Trace"}`);
  }

  handleFocusLost() {
    this.sendWidgetEvent("FOCUS_LOST", "WARNING", "App interface context shifted target out of focal view");
  }

  handleFocusReturned() {
    this.sendWidgetEvent("FOCUS_RETURNED", "INFO", "Interface view restored active state context");
  }

  leaveRoom() {
    this.connectionInProgress = false;
    if (this.activeRoom) {
      try {
        this.activeRoom.disconnect();
      } catch (e) {
        console.error("Error breaking down active WebRTC session topology", e);
      }
      this.activeRoom = null;
    }
    this.stopLocalTracks();
    this.localDataTrack = null;
    if (this.remoteMediaRef.current) this.remoteMediaRef.current.innerHTML = "";
    this.participantContainers.clear();
    this.updateConnectionState();
  }

  render() {
    const { showDiagnostics } = this.props;
    const { connectionState, isMicrophoneMuted, isCameraMuted, participantCount, showLogs } = this.state;
    const isConnected = connectionState === "Connected";
    const isPreview = connectionState === "Preview";
    const isAgent = this.isAgentParticipant();

    return (
      <div className={`twilio-video isr-layout-root ${isAgent ? 'mode-agent' : 'mode-customer'}`}>
        
        {/* UPPER PANEL: Core Status & Metadata Sync Header */}
        <div className="twilio-controls">
          <div className={`twilio-status-indicator ${connectionState.toLowerCase()}`}>
            <span className="twilio-status-dot"></span>
            <span className="twilio-status-text">
              {isConnected ? `Room Session Active (Peers: ${participantCount})` : `Connection: ${connectionState}`}
            </span>
          </div>

          {/* Customer Passive Status Panel (Visible only on Customer side) */}
          {isConnected && !isAgent && (
            <div className="customer-info-badges">
              <span className={`badge-indicator ${isMicrophoneMuted ? 'state-off' : 'state-on'}`}>
                {isMicrophoneMuted ? "🎤 Microphone Muted" : "🎤 Microphone Live"}
              </span>
              <span className={`badge-indicator ${isCameraMuted ? 'state-off' : 'state-on'}`}>
                {isCameraMuted ? "📹 Webcam Stopped" : "📹 Webcam Live"}
              </span>
            </div>
          )}
        </div>

        {/* MAIN PANEL: Clean-Cut Layout Frames (Eliminates all stray placeholder black areas) */}
        <div className="video-viewport-container">
          {/* Agent Canvas: Renders only the incoming customer view stream */}
          {isAgent && isConnected && (
            <div ref={this.remoteMediaRef} className="media remote-media isr-agent-canvas"></div>
          )}

          {/* Customer Canvas: Renders only their own local preview track profile layout canvas */}
          {!isAgent && (isPreview || isConnected) && (
            <div ref={this.localMediaRef} className="media local-media isr-customer-canvas"></div>
          )}
        </div>

        {/* LOWER PANEL: Agent Administrative Dashboard Console Layout Control Center */}
        {isAgent && isConnected && (
          <div className="agent-administrative-dashboard-panel">
            
            {/* Dashboard Action Row 1: Real-Time WebRTC Media Overrides Tracking Matrix */}
            <div className="dashboard-action-row">
              <span className="row-group-label">Customer Audio:</span>
              <button type="button" className="twilio-control-btn override-btn active" onClick={() => this.sendRemoteControlCommand("SET_MICROPHONE", true)}>🎤 Force Mic ON</button>
              <button type="button" className="twilio-control-btn override-btn muted" onClick={() => this.sendRemoteControlCommand("SET_MICROPHONE", false)}> Mute Mic</button>
              
              <span className="row-group-label separator">Customer Video:</span>
              <button type="button" className="twilio-control-btn override-btn active" onClick={() => this.sendRemoteControlCommand("SET_CAMERA", true)}>📹 Force Cam ON</button>
              <button type="button" className="twilio-control-btn override-btn muted" onClick={() => this.sendRemoteControlCommand("SET_CAMERA", false)}>❌ Cam OFF</button>
            </div>

            {/* Dashboard Action Row 2: Verification Tools Subsystem Command Line Panel */}
            <div className="dashboard-action-row utilities-row">
              <button type="button" className="twilio-control-btn utility-action-btn screenshot-btn" onClick={() => this.captureCustomerScreenshot()}>📸 Take Verification Snapshot</button>
              <button type="button" className="twilio-control-btn utility-action-btn log-toggle-btn" onClick={() => this.setState({ showLogs: !showLogs })}>{showLogs ? "👁️ Hide Event Log" : "👁️ Display Event Log"}</button>
              <button type="button" className="twilio-control-btn utility-action-btn terminate-btn" onClick={() => { this.sendRemoteControlCommand("TERMINATE_SESSION", true); this.leaveRoom(); }}>🛑 End Video Session</button>
            </div>

            {/* Dashboard Action Row 3: Technical Platform Node Metrics Monitor */}
            {showDiagnostics && (
              <div className="twilio-diagnostics-data-grid">
                <div><strong>ISR Secure Node Verification Platform Engine</strong> | Widget Target Build: {WIDGET_VERSION}</div>
                <div className="metrics-wrapper">
                  <span>Routing: Agent Dashboard Console</span>
                  <span>Active Channel Topology: {connectionState}</span>
                  <span>Twilio Bundle Base: {TWILIO_SDK_VERSION}</span>
                  <span>Instance Key Hash: {this.instanceId}</span>
                </div>
              </div>
            )}

            {/* Dashboard Action Row 4: Expandable System Event Terminal Log Log window */}
            <div ref={this.logRef} className="log system-events-terminal-log" style={{ display: showLogs ? "block" : "none" }}></div>
          </div>
        )}
      </div>
    );
  }
}

export default hot(TwilioVideoChat);