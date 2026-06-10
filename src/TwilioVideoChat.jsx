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
        if (prevJoinRoom === true) {
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
    try {
      const isAgent = this.isAgentParticipant();
      
      // If client is agent, execute command across room data track channel
      if (isAgent) {
        const targetMuteInstruction = forceState !== null ? forceState : this.state.isMicrophoneMuted;
        this.sendRemoteControlCommand("SET_MICROPHONE", targetMuteInstruction);
        this.setState({ isMicrophoneMuted: !targetMuteInstruction });
        return;
      }

      // If client is customer, adjust hardware directly
      if (!this.activeRoom?.localParticipant) return;
      this.activeRoom.localParticipant.audioTracks.forEach(pub => {
        if (pub.track) {
          if (forceState !== null) {
            forceState ? pub.track.enable() : pub.track.disable();
          } else {
            pub.track.isEnabled ? pub.track.disable() : pub.track.enable();
          }
        }
      });

      const audioTrack = Array.from(this.activeRoom.localParticipant.audioTracks.values())[0]?.track;
      this.setState({ isMicrophoneMuted: audioTrack ? !audioTrack.isEnabled : true });
    } catch (e) {
      this.handleError("Error adjusting microphone tracking stream", e);
    }
  }

  toggleCamera(forceState = null) {
    try {
      const isAgent = this.isAgentParticipant();

      // If client is agent, execute command across room data track channel
      if (isAgent) {
        const targetCamInstruction = forceState !== null ? forceState : this.state.isCameraMuted;
        this.sendRemoteControlCommand("SET_CAMERA", targetCamInstruction);
        this.setState({ isCameraMuted: !targetCamInstruction });
        return;
      }

      // If client is customer, handle hardware streams directly
      if (!this.activeRoom?.localParticipant) return;
      const localParticipant = this.activeRoom.localParticipant;
      const videoTrackPub = Array.from(localParticipant.videoTracks.values())[0];
      const shouldMute = forceState !== null ? !forceState : !this.state.isCameraMuted;
      
      if (shouldMute) {
        if (videoTrackPub && videoTrackPub.track) {
          videoTrackPub.track.disable();
          videoTrackPub.track.stop();
        }
        this.setState({ isCameraMuted: true });
        this.log("Webcam stream completely stopped.");
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

          if (videoTrackPub && videoTrackPub.track) {
            localParticipant.unpublishTrack(videoTrackPub.track);
            videoTrackPub.track.detach().forEach(el => el.remove());
          }
          
          localParticipant.publishTrack(newTrack);
          this.setState({ isCameraMuted: false });
          
          const localContainer = this.localMediaRef.current;
          if (localContainer) {
            while (localContainer.firstChild) {
              localContainer.removeChild(localContainer.firstChild);
            }
            this.attachTrack(newTrack, localContainer);
          }
          this.log("Webcam stream re-established.");
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
      this.log(`Dispatched override event: ${commandName} -> ${targetValue}`);
    } else {
      this.log("Command failed: Data Track layer is offline.");
    }
  }

  captureCustomerScreenshot() {
    if (!this.isAgentParticipant() || !this.remoteMediaRef.current) return;

    try {
      const videoEl = this.remoteMediaRef.current.querySelector("video");
      if (!videoEl) {
        this.log("Screenshot failure: No customer video feed active on browser DOM canvas.");
        return;
      }

      const canvas = document.createElement("canvas");
      canvas.width = videoEl.videoWidth || 640;
      canvas.height = videoEl.videoHeight || 480;

      const ctx = canvas.getContext("2d");
      ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);

      const base64Data = canvas.toDataURL("image/png");
      this.log("Customer snapshot compiled successfully.");

      this.sendWidgetEvent("SCREENSHOT_CAPTURED", "INFO", "Customer snapshot verification frame compiled.", {
        screenshotDataURI: base64Data
      });
    } catch (err) {
      this.log(`Snapshot capture exception: ${err?.message}`);
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
      console.error("Error executing clean component track detach", e);
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
      this.log("Agent interface session loading context linked.");
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
          this.log("Hardware media drivers busy or blocked by host policies.");
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
      this.handleError("Customer room handshake linking channel initiation failure", error);
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

    this.log(`Successfully mapped room channel allocation block. Client identity: ${identity}`);
    
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

    // CRITICAL TRACK SIGNALING FIX: Immediate ingestion listener block
    const handleTrackPublication = (pub) => {
      if (pub.track) {
        setupDataTrackListener(pub.track);
      } else {
        pub.on('subscribed', (track) => setupDataTrackListener(track));
      }
    };

    const setupDataTrackListener = (track) => {
      if (track.kind === 'data') {
        track.on('message', (data) => {
          try {
            const parsed = JSON.parse(data);
            this.log(`Decoded real-time payload command: ${parsed.command}`);
            
            if (!this.isAgentParticipant()) {
              if (parsed.command === "SET_CAMERA") {
                this.toggleCamera(parsed.value);
              }
              if (parsed.command === "SET_MICROPHONE") {
                this.toggleMicrophone(parsed.value);
              }
              if (parsed.command === "TERMINATE_SESSION") {
                this.log("Agent clicked end session. Disconnecting room channel.");
                this.leaveRoom();
              }
              if (parsed.command === "FORCE_RECONNECT") {
                this.log("Agent requested hardware stream re-evaluation loop.");
                this.executeForceReconnectAction();
              }
            }
          } catch (err) {
            console.error("Signaling frame parsing failure:", err);
          }
        });
      } else {
        if (this.isAgentParticipant()) {
          this.attachTrack(track, tracksContainer);
        }
      }
    };

    participant.tracks.forEach(handleTrackPublication);
    participant.on('trackPublished', handleTrackPublication);

    participant.on('trackUnsubscribed', (track) => {
      if (track.kind !== 'data') this.detachTrack(track);
    });
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
    this.log(`${message}: ${error?.message || "Unknown Platform Error Exception"}`);
  }

  handleFocusLost() {
    this.sendWidgetEvent("FOCUS_LOST", "WARNING", "App interface context shifted target out of focal view");
  }

  handleFocusReturned() {
    this.sendWidgetEvent("FOCUS_RETURNED", "INFO", "Interface view restored active state context");
  }

  async showPreview() {
    if (this.isAgentParticipant()) return;

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
      this.log(`Preview window creation failure: ${error?.message}`);
    }
  }

  hidePreview() {
    this.stopLocalTracks();
    this.updateConnectionState();
  }

  executeForceReconnectAction() {
    this.log("Executing dynamic device cleanup loop and reconnecting...");
    this.leaveRoom();
    setTimeout(() => {
      if (this._isMounted) {
        if (this.props.joinRoomActiveExpr && typeof this.props.joinRoomActiveExpr.setValue === "function") {
          this.props.joinRoomActiveExpr.setValue(true);
        } else {
          this.joinRoom();
        }
      }
    }, 1200); 
  }

  leaveRoom() {
    this.connectionInProgress = false;
    if (this.activeRoom) {
      try {
        this.activeRoom.disconnect();
      } catch (e) {
        console.error("Error tearing down current WebRTC channel layer", e);
      }
      this.activeRoom = null;
    }
    this.stopLocalTracks();
    this.localDataTrack = null;
    if (this.remoteMediaRef.current) this.remoteMediaRef.current.innerHTML = "";
    this.participantContainers.clear();
    this.updateConnectionState();

    // CRITICAL LOOP RESET: Unchecks the Mendix variable so the loop doesn't restart auto-connecting
    if (this.props.joinRoomActiveExpr && typeof this.props.joinRoomActiveExpr.setValue === "function") {
      this.props.joinRoomActiveExpr.setValue(false);
    }
  }

  render() {
    const { 
      showDiagnostics,
      captionSessionDisconnected,
      captionSessionConnecting,
      captionSessionConnected,
      captionDisconnectCall,
      captionReconnectCall,
      captionMicActive,
      captionMicMuted,
      captionCamActive,
      captionCamOff
    } = this.props;

    const { connectionState, isMicrophoneMuted, isCameraMuted, participantCount, showLogs } = this.state;
    const isConnected = connectionState === "Connected";
    const isPreview = connectionState === "Preview";
    const isAgent = this.isAgentParticipant();

    // Mapping Status Captions from Mendix Properties Layout
    let displayedStatusText = captionSessionDisconnected?.value || "Session: Disconnected";
    if (this.connectionInProgress) {
      displayedStatusText = captionSessionConnecting?.value || "Session: Connecting...";
    } else if (isConnected) {
      displayedStatusText = `${captionSessionConnected?.value || "Room Active"} (${participantCount})`;
    } else if (isPreview) {
      displayedStatusText = "Preview Mode Active";
    }

    return (
      <div className={`twilio-video isr-layout-root ${isAgent ? 'mode-agent' : 'mode-customer'}`}>
        
        {/* UPPER PANEL: Header Bar Status Indicators */}
        <div className="twilio-controls">
          <div className={`twilio-status-indicator ${connectionState.toLowerCase()}`}>
            <span className="twilio-status-dot"></span>
            <span className="twilio-status-text">{displayedStatusText}</span>
          </div>

          {/* Customer Side Passive Status Badge Rows */}
          {isConnected && !isAgent && (
            <div className="customer-info-badges">
              <span className={`badge-indicator ${isMicrophoneMuted ? 'state-off' : 'state-on'}`}>
                {isMicrophoneMuted ? (captionMicMuted?.value || "🎤 Mic Muted") : (captionMicActive?.value || "🎤 Mic Active")}
              </span>
              <span className={`badge-indicator ${isCameraMuted ? 'state-off' : 'state-on'}`}>
                {isCameraMuted ? (captionCamOff?.value || "📹 Camera Off") : (captionCamActive?.value || "📹 Camera Active")}
              </span>
            </div>
          )}
        </div>

        {/* MAIN VIDEO VIEWPORT CANVAS MATRIX */}
        <div className="video-viewport-container">
          {isAgent && isConnected && (
            <div ref={this.remoteMediaRef} className="media remote-media isr-agent-canvas"></div>
          )}
          {!isAgent && (isPreview || isConnected) && (
            <div ref={this.localMediaRef} className="media local-media isr-customer-canvas"></div>
          )}
        </div>

        {/* LOWER OPERATIONS FOOTER BAR CONTROL CENTER */}
        <div className="bottom-dashboard-interface-wrapper">
          
          {/* CUSTOMER PANEL VIEWS BAR */}
          {!isAgent && (
            <div className="customer-operational-action-bar">
              {isConnected ? (
                <button type="button" className="twilio-control-btn customer-btn disconnect-call-btn" onClick={() => this.leaveRoom()}>
                  🛑 {captionDisconnectCall?.value || "Disconnect Call"}
                </button>
              ) : (
                <button type="button" className="twilio-control-btn customer-btn reconnect-call-btn" onClick={() => this.executeForceReconnectAction()}>
                  🔄 {captionReconnectCall?.value || "Reconnect Call"}
                </button>
              )}
            </div>
          )}

          {/* AGENT ADMINISTRATIVE PIPELINE BAR */}
          {isAgent && isConnected && (
            <div className="agent-administrative-dashboard-panel">
              
              {/* Row 1: Real-Time Toggle Signal Triggers */}
              <div className="dashboard-action-row">
                <span className="row-group-label">Customer Audio:</span>
                <button type="button" className={`twilio-control-btn override-btn ${!isMicrophoneMuted ? 'active' : ''}`} onClick={() => this.toggleMicrophone(true)}>🎤 Force Mic ON</button>
                <button type="button" className={`twilio-control-btn override-btn ${isMicrophoneMuted ? 'muted' : ''}`} onClick={() => this.toggleMicrophone(false)}>🔇 Mute Mic</button>
                
                <span className="row-group-label separator">Customer Video:</span>
                <button type="button" className={`twilio-control-btn override-btn ${!isCameraMuted ? 'active' : ''}`} onClick={() => this.toggleCamera(true)}>📹 Force Cam ON</button>
                <button type="button" className={`twilio-control-btn override-btn ${isCameraMuted ? 'muted' : ''}`} onClick={() => this.toggleCamera(false)}>❌ Cam OFF</button>
              </div>

              {/* Row 2: Customer Operations Management Subsystem */}
              <div className="dashboard-action-row utilities-row">
                <button type="button" className="twilio-control-btn utility-action-btn reconnect-override-btn" onClick={() => this.sendRemoteControlCommand("FORCE_RECONNECT", true)}>🔄 Force Customer Reconnect</button>
                <button type="button" className="twilio-control-btn utility-action-btn screenshot-btn" onClick={() => this.captureCustomerScreenshot()}>📸 Take Verification Snapshot</button>
                <button type="button" className="twilio-control-btn utility-action-btn log-toggle-btn" onClick={() => this.setState({ showLogs: !showLogs })}>{showLogs ? "👁️ Hide Log Window" : "👁️ Display Log Window"}</button>
                <button type="button" className="twilio-control-btn utility-action-btn terminate-btn" onClick={() => { this.sendRemoteControlCommand("TERMINATE_SESSION", true); this.leaveRoom(); }}>🛑 Close All Rooms</button>
              </div>

              {/* Row 3: Technical Metrics Summary Layer */}
              {showDiagnostics && (
                <div className="twilio-diagnostics-data-grid">
                  <div><strong>ISR Secure Node Verification Platform Engine</strong> | Build Version: {WIDGET_VERSION}</div>
                  <div className="metrics-wrapper">
                    <span>Node Context Assignment: Agent Console</span>
                    <span>Channel State: {connectionState}</span>
                    <span>Twilio SDK Module Bundle: {TWILIO_SDK_VERSION}</span>
                    <span>Unique Instance Hash: {this.instanceId}</span>
                  </div>
                </div>
              )}

              {/* Row 4: Event Console Terminal Log Box */}
              <div ref={this.logRef} className="log system-events-terminal-log" style={{ display: showLogs ? "block" : "none" }}></div>
            </div>
          )}
        </div>
      </div>
    );
  }
}

export default hot(TwilioVideoChat);