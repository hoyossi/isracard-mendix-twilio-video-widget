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
      participantCount: 0
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

  toggleMicrophone() {
    if (!this.activeRoom?.localParticipant) return;
    try {
      const audioTrackPub = Array.from(this.activeRoom.localParticipant.audioTracks.values())[0];
      if (!audioTrackPub?.track) return;

      const shouldMute = !this.state.isMicrophoneMuted;
      if (shouldMute) {
        audioTrackPub.track.disable();
        this.setState({ isMicrophoneMuted: true });
      } else {
        audioTrackPub.track.enable();
        this.setState({ isMicrophoneMuted: false });
      }
    } catch (e) {
      this.handleError("Error toggling microphone", e);
    }
  }

  toggleCamera() {
    if (!this.activeRoom?.localParticipant) return;
    
    try {
      const videoTrackPub = Array.from(this.activeRoom.localParticipant.videoTracks.values())[0];
      
      const shouldMute = !this.state.isCameraMuted;
      if (shouldMute) {
        if (videoTrackPub?.track) {
          videoTrackPub.track.disable();
          videoTrackPub.track.stop();
        }
        this.setState({ isCameraMuted: true });
        this.log("Camera hardware track disabled and stopped.");
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
          this.log("Camera hardware track re-established.");
        });
      }
    } catch (e) {
      this.handleError("Error toggling camera track channel", e);
    }
  }

  sendRemoteControlCommand(commandName, targetValue) {
    if (!this.isAgentParticipant()) return;
    
    if (this.localDataTrack) {
      const payload = JSON.stringify({ command: commandName, value: targetValue });
      this.localDataTrack.send(payload);
      this.log(`Sent remote command to room: ${commandName} -> ${targetValue}`);
    } else {
      this.log("Unable to execute remote command: Data channel offline.");
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
          console.error("Error completely stopping local track stream", e);
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
        console.error("Fallback live track parsing failure", err);
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
      console.error("Error tracking DOM attach node", e);
    }
  }

  detachTrack(track) {
    if (!track || typeof track.detach !== "function") return;
    try {
      track.detach().forEach(element => element?.remove());
    } catch (e) {
      console.error("Error executing safe detach track", e);
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
      this.log("Agent joining session with remote control Data Track active.");
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

    try {
      const deviceCheckResult = await performDeviceCheck({ requireCamera: false, requireMicrophone: false });
      let finalAudio = deviceCheckResult.success; 
      let finalVideo = deviceCheckResult.success; 

      this.stopLocalTracks(); 

      if (finalAudio || finalVideo) {
        try {
          const hardwareTracks = await Video.createLocalTracks({
            audio: finalAudio,
            video: finalVideo ? { width: videoWidth, height: videoHeight } : false
          });
          this.localTracks = hardwareTracks;
        } catch (err) {
          this.log("Hardware profiles busy, dropping media hardware layer.");
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
      this.handleError("Customer room handshaking sequence failed", error);
    }
  }

  async showPreview() {
    if (this.isAgentParticipant()) {
      this.log("Preview window rejected: Current instance role is Agent.");
      return;
    }

    const videoWidth = this.getIntegerProp("videoWidth", 640);
    const videoHeight = this.getIntegerProp("videoHeight", 480);

    try {
      this.stopLocalTracks();
      
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
    this.stopLocalTracks();
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
    this.localDataTrack = null;
    if (this.remoteMediaRef.current) this.remoteMediaRef.current.innerHTML = "";
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

    if (localContainer && this.localTracks.length > 0) {
      this.localTracks.forEach(track => {
        if (track.kind !== 'data') this.attachTrack(track, localContainer);
      });
    }

    room.participants.forEach(participant => {
      this.handleParticipantConnected(participant, remoteContainer);
    });

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
            this.log(`Received explicit data payload command: ${parsed.command}`);
            
            if (!this.isAgentParticipant()) {
              if (parsed.command === "SET_CAMERA") {
                const targetMuteState = !parsed.value; 
                if (this.state.isCameraMuted !== targetMuteState) {
                  this.toggleCamera();
                }
              }
              if (parsed.command === "SET_MICROPHONE") {
                const targetMuteState = !parsed.value;
                if (this.state.isMicrophoneMuted !== targetMuteState) {
                  this.toggleMicrophone();
                }
              }
            }
          } catch (err) {
            console.error("Data Track parsing runtime exception context:", err);
          }
        });
      } else {
        this.attachTrack(track, tracksContainer);
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
    this.log(`${message}: ${error?.message || "Unknown Exception"}`);
  }

  handleFocusLost() {
    this.sendWidgetEvent("FOCUS_LOST", "WARNING", "App interface context shifted target out of focal view");
  }

  handleFocusReturned() {
    this.sendWidgetEvent("FOCUS_RETURNED", "INFO", "Interface view restored active state context");
  }

  render() {
    const { showDiagnostics, participantSide } = this.props;
    const { connectionState, isMicrophoneMuted, isCameraMuted, participantCount } = this.state;
    const isConnected = connectionState === "Connected";
    const isPreview = connectionState === "Preview";
    const isAgent = this.isAgentParticipant();

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
              {isAgent ? (
                <div className="agent-remote-dashboard">
                  <span className="dashboard-title">Customer Overrides:</span>
                  <button 
                    type="button"
                    className="twilio-control-btn remote-override-btn target-cam-on"
                    onClick={() => this.sendRemoteControlCommand("SET_CAMERA", true)}
                  >
                    📷 Force Camera ON
                  </button>
                  <button 
                    type="button"
                    className="twilio-control-btn remote-override-btn target-cam-off"
                    onClick={() => this.sendRemoteControlCommand("SET_CAMERA", false)}
                  >
                    🚫 Camera OFF
                  </button>
                </div>
              ) : (
                <>
                  <button
                    type="button"
                    className={`twilio-control-btn twilio-microphone-btn ${isMicrophoneMuted ? 'muted' : 'active'}`}
                    onClick={() => this.toggleMicrophone()}
                  >
                    <span className="twilio-icon">{isMicrophoneMuted ? '🔇' : '🎤'}</span>
                    <span className="twilio-label">{isMicrophoneMuted ? 'Muted' : 'Mic'}</span>
                  </button>

                  <button
                    type="button"
                    className={`twilio-control-btn twilio-camera-btn ${isCameraMuted ? 'muted' : 'active'}`}
                    onClick={() => this.toggleCamera()}
                  >
                    <span className="twilio-icon">{isCameraMuted ? '❌📹' : '📹'}</span>
                    <span className="twilio-label">{isCameraMuted ? 'Off' : 'Camera'}</span>
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        <div ref={this.remoteMediaRef} className="media remote-media" style={{ display: isConnected ? "flex" : "none" }}></div>
        <div ref={this.localMediaRef} className="media local-media" style={{ display: (isPreview || isConnected) && !isAgent ? "block" : "none" }}></div>

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