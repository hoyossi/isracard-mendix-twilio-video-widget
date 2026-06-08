import { Component, createElement } from "react";
import { hot } from "react-hot-loader/root";

import "./ui/TwilioVideoChat.css";
import { buildWidgetEvent, emitWidgetEvent } from "./services/eventLogger";
import { performDeviceCheck } from "./services/deviceService";
import {
  WIDGET_VERSION,
  WIDGET_FEATURES,
  TWILIO_SDK_VERSION
} from "./version";

const Video = require('twilio-video');

class TwilioVideoChat extends Component {
  constructor(props) {
    super(props);

    this.state = {
      connectionState: "Disconnected", // Disconnected, Connecting, Preview, Connected
      isMicrophoneMuted: false,
      isCameraMuted: false,
      participantCount: 0
    };

    // Instance-level state (not React state, but instance-scoped)
    this.instanceId = Math.random().toString(36).substr(2, 9);
    this.activeRoom = null;
    this.localTracks = [];
    this.participantContainers = {};
    this.connectionInProgress = false;
    this.joinRoomToggle = false;
    this.previewToggle = false;
    this.focusLost = false;
    this.eventListeners = [];
  }

  componentDidMount() {
    // Register event listeners as instance methods bound to this widget
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
  }

  componentWillUnmount() {
    // Clean up: remove all event listeners
    this.eventListeners.forEach(({ target, event, handler }) => {
      target.removeEventListener(event, handler);
    });
    this.eventListeners = [];

    // Clean up tracks and room
    this.leaveRoom();
  }

  registerEventListener(target, event, handler) {
    target.addEventListener(event, handler);
    this.eventListeners.push({ target, event, handler });
  }

  componentDidUpdate() {
    const { joinRoomActiveExpr, previewActiveExpr } = this.props;

    const shouldJoinRoom = joinRoomActiveExpr && joinRoomActiveExpr.value;
    const shouldShowPreview = previewActiveExpr && previewActiveExpr.value;

    if (shouldJoinRoom && !this.joinRoomToggle) {
      this.joinRoom();
    } else if (!shouldJoinRoom && this.joinRoomToggle) {
      this.leaveRoom();
    }

    if (shouldShowPreview && !this.previewToggle) {
      this.showPreview();
    } else if (!shouldShowPreview && this.previewToggle) {
      this.hidePreview();
    }
  }

  log(message) {
    const { logActiveExpr, logSelector } = this.props;
    if (logActiveExpr && logActiveExpr.value) {
      const selector = logSelector || 'div.twilio-video div.log';
      const logElement = document.querySelector(selector);
      if (logElement) {
        logElement.innerHTML += '<p>' + message + '</p>';
      }
    }
  }

  getConnectionState() {
    if (this.connectionInProgress) {
      return "Connecting";
    }
    if (this.activeRoom) {
      return "Connected";
    }
    if (this.localTracks.length > 0) {
      return "Preview";
    }
    return "Disconnected";
  }

  toggleMicrophone() {
    if (!this.activeRoom) {
      this.log("Cannot toggle microphone: not connected to room");
      return;
    }

    try {
      const localParticipant = this.activeRoom.localParticipant;
      if (!localParticipant) return;

      const audioTrack = Array.from(localParticipant.audioTracks.values())[0];
      if (!audioTrack) {
        this.log("No audio track available");
        return;
      }

      const isMuted = !this.state.isMicrophoneMuted;
      audioTrack.track.disable();
      this.setState({ isMicrophoneMuted: isMuted });

      this.log(isMuted ? "Microphone muted" : "Microphone unmuted");
      this.sendWidgetEvent(
        "MICROPHONE_TOGGLED",
        "INFO",
        isMuted ? "Microphone muted" : "Microphone unmuted",
        { isMuted }
      );
    } catch (e) {
      console.error("Error toggling microphone", e);
      this.log("Error toggling microphone: " + (e?.message || "Unknown error"));
    }
  }

  toggleCamera() {
    if (!this.activeRoom) {
      this.log("Cannot toggle camera: not connected to room");
      return;
    }

    try {
      const localParticipant = this.activeRoom.localParticipant;
      if (!localParticipant) return;

      const videoTrack = Array.from(localParticipant.videoTracks.values())[0];
      if (!videoTrack) {
        this.log("No video track available");
        return;
      }

      const isMuted = !this.state.isCameraMuted;
      videoTrack.track.disable();
      this.setState({ isCameraMuted: isMuted });

      this.log(isMuted ? "Camera muted" : "Camera unmuted");
      this.sendWidgetEvent(
        "CAMERA_TOGGLED",
        "INFO",
        isMuted ? "Camera muted" : "Camera unmuted",
        { isMuted }
      );
    } catch (e) {
      console.error("Error toggling camera", e);
      this.log("Error toggling camera: " + (e?.message || "Unknown error"));
    }
  }

  updateConnectionState() {
    this.setState({ connectionState: this.getConnectionState() });
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
    if (!prop || prop.value === undefined || prop.value === null) {
      return defaultValue;
    }
    const parsedValue = parseInt(prop.value, 10);
    return isNaN(parsedValue) ? defaultValue : parsedValue;
  }

  getBooleanProp(propName, defaultValue) {
    const prop = this.props[propName];
    if (!prop || prop.value === undefined || prop.value === null) {
      return defaultValue;
    }
    return prop.value;
  }

  getParticipantSide() {
    return this.props.participantSide || "customer";
  }

  isAgentParticipant() {
    return this.getParticipantSide() === "agent";
  }

  getDefaultMediaEnabled() {
    return this.isAgentParticipant() ? false : true;
  }

  hasActiveLocalTracks() {
    return this.localTracks && this.localTracks.some(track => {
      return track && track.mediaStreamTrack && track.mediaStreamTrack.readyState === "live";
    });
  }

  getPreviewContainer() {
    const selector = this.props.previewSelector || 'div.twilio-video div.local-media';
    return document.querySelector(selector);
  }

  clearPreviewContainer() {
    const previewContainer = this.getPreviewContainer();
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
          this.detachTrack(track);

          if (track.mediaStreamTrack && typeof track.mediaStreamTrack.stop === "function") {
            track.mediaStreamTrack.stop();
          }

          if (typeof track.stop === "function") {
            track.stop();
          }
        } catch (e) {
          console.error("Error stopping local track", e);
        }
      });
    }

    this.localTracks = [];
    this.clearPreviewContainer();
  }

  attachTrack(track, container) {
    if (!track || !container || typeof track.attach !== "function") {
      return;
    }
    try {
      container.appendChild(track.attach());
    } catch (e) {
      console.error("Error attaching track", e);
    }
  }

  attachTracks(tracks, container) {
    if (Array.isArray(tracks)) {
      tracks.forEach(track => this.attachTrack(track, container));
    }
  }

  detachTrack(track) {
    if (!track || typeof track.detach !== "function") {
      return;
    }
    try {
      track.detach().forEach(element => {
        if (element && element.parentNode) {
          element.parentNode.removeChild(element);
        }
      });
    } catch (e) {
      console.error("Error detaching track", e);
    }
  }

  removeParticipantContainer(participant) {
    if (!participant) return;

    const container = this.participantContainers[participant.identity];
    if (container && container.parentNode) {
      container.parentNode.removeChild(container);
    }
    delete this.participantContainers[participant.identity];
  }

  trackPublished(publication, container) {
    if (!publication || !container) return;

    if (publication.isSubscribed) {
      this.attachTrack(publication.track, container);
    }

    const subscribedHandler = (track) => {
      this.attachTrack(track, container);
    };

    const unsubscribedHandler = (track) => {
      this.detachTrack(track);
    };

    publication.once('subscribed', subscribedHandler);
    publication.once('unsubscribed', unsubscribedHandler);
  }

  participantConnected(participant, container) {
    if (!participant || !container) return;

    const participantContainer = document.createElement('div');
    participantContainer.className = 'participant-container';
    container.appendChild(participantContainer);

    const tracksContainer = document.createElement('div');
    tracksContainer.className = 'participant-tracks';
    participantContainer.appendChild(tracksContainer);

    const nameContainer = document.createElement('div');
    nameContainer.className = 'participant-name';
    nameContainer.textContent = participant.identity;
    participantContainer.appendChild(nameContainer);

    this.participantContainers[participant.identity] = participantContainer;

    participant.tracks.forEach(publication => {
      this.trackPublished(publication, tracksContainer);
    });

    const trackPublishedHandler = (publication) => {
      this.trackPublished(publication, tracksContainer);
    };

    const trackUnpublishedHandler = (publication) => {
      // Track will be detached via unsubscribed event
    };

    participant.once('trackPublished', trackPublishedHandler);
    participant.once('trackUnpublished', trackUnpublishedHandler);
  }

  detachParticipantTracks(participant) {
    if (!participant) return;

    try {
      Array.from(participant.tracks.values()).forEach(publication => {
        if (publication.track) {
          this.detachTrack(publication.track);
        }
      });
    } catch (e) {
      console.error("Error detaching participant tracks", e);
    }
  }

  async joinRoom() {
    const { roomNameExpr, nickNameExpr, accessTokenExpr } = this.props;

    const roomName = roomNameExpr?.value;
    const identity = nickNameExpr?.value;
    const token = accessTokenExpr?.value;

    if (!roomName || !identity || !token) {
      this.log("Missing room name, identity, or token");
      return;
    }

    if (this.connectionInProgress) {
      this.log("Connection already in progress");
      return;
    }

    this.connectionInProgress = true;
    this.joinRoomToggle = true;
    this.updateConnectionState();

    const isAgent = this.isAgentParticipant();
    const defaultMediaEnabled = this.getDefaultMediaEnabled();
    const audioEnabled = this.getBooleanProp("microphoneEnabledExpr", defaultMediaEnabled);
    const videoEnabled = this.getBooleanProp("cameraEnabledExpr", defaultMediaEnabled);
    const videoWidth = this.getIntegerProp("videoWidth", 640);
    const videoHeight = this.getIntegerProp("videoHeight", 480);

    const connectOptions = {
      name: roomName,
      logLevel: "warn"
    };

    if (isAgent) {
      this.log("Agent joining without local audio/video tracks");

      this.sendWidgetEvent(
        "DEVICE_CHECK_SKIPPED",
        "INFO",
        "Device check skipped for agent participant without local media",
        {
          participantSide: this.getParticipantSide(),
          audioEnabled: false,
          videoEnabled: false
        }
      );

      connectOptions.tracks = [];

      try {
        const room = await Video.connect(token, connectOptions);
        this.roomJoined(room, identity);
      } catch (error) {
        this.joinRoomToggle = false;
        this.connectionInProgress = false;
        this.updateConnectionState();
        this.handleError("Could not connect to Twilio", error);
      }

      return;
    }

    this.sendWidgetEvent(
      "DEVICE_CHECK_STARTED",
      "INFO",
      "Device check started",
      {
        participantSide: this.getParticipantSide(),
        audioEnabled,
        videoEnabled,
        videoWidth,
        videoHeight
      }
    );

    try {
      const deviceCheckResult = await performDeviceCheck({
        requireCamera: false,
        requireMicrophone: false
      });

      let finalAudioEnabled = audioEnabled;
      let finalVideoEnabled = videoEnabled;

      if (!deviceCheckResult.success) {
        this.sendWidgetEvent(
          "DEVICE_CHECK_FAILED",
          "WARNING",
          "Device check failed - attempting to join without local media",
          deviceCheckResult
        );

        this.log("Warning: Device check failed - " + deviceCheckResult.errors.join(", ") + " - joining without local media");
        finalAudioEnabled = false;
        finalVideoEnabled = false;
      } else {
        this.sendWidgetEvent(
          "DEVICE_CHECK_PASSED",
          "INFO",
          "Device check passed",
          deviceCheckResult
        );
      }

      this.log("Joining room '" + roomName + "'...");
      this.log(
        "Creating local tracks. Camera: " +
        finalVideoEnabled +
        ", Microphone: " +
        finalAudioEnabled +
        ", Width: " +
        videoWidth +
        ", Height: " +
        videoHeight
      );

      let localTracks = [];

      if (finalAudioEnabled || finalVideoEnabled) {
        if (this.hasActiveLocalTracks()) {
          localTracks = this.localTracks;
        } else {
          try {
            localTracks = await Video.createLocalTracks({
              audio: finalAudioEnabled,
              video: finalVideoEnabled
                ? {
                    width: videoWidth,
                    height: videoHeight
                  }
                : false
            });
          } catch (error) {
            this.log("Warning: Unable to access Camera/Microphone - " + (error?.message || "Unknown error") + " - joining without local media");
            localTracks = [];
          }
        }
      }

      this.localTracks = localTracks || [];
      connectOptions.tracks = this.localTracks;

      const room = await Video.connect(token, connectOptions);
      this.roomJoined(room, identity);
    } catch (error) {
      this.joinRoomToggle = false;
      this.connectionInProgress = false;
      this.updateConnectionState();
      this.handleError("Unable to complete room join", error);
    }
  }

  async showPreview() {
    if (this.isAgentParticipant()) {
      this.log("Camera preview skipped - agent participant does not use local media");
      this.previewToggle = false;
      return;
    }

    const defaultMediaEnabled = this.getDefaultMediaEnabled();
    const videoEnabled = this.getBooleanProp("cameraEnabledExpr", defaultMediaEnabled);

    if (!videoEnabled) {
      this.log("Camera preview skipped - camera disabled");
      this.previewToggle = false;
      return;
    }

    this.previewToggle = true;
    const videoWidth = this.getIntegerProp("videoWidth", 640);
    const videoHeight = this.getIntegerProp("videoHeight", 480);

    this.log(
      "Creating local preview track. Camera: " +
      videoEnabled +
      ", Width: " +
      videoWidth +
      ", Height: " +
      videoHeight
    );

    try {
      const deviceCheckResult = await performDeviceCheck({
        requireCamera: false,
        requireMicrophone: false
      });

      if (!deviceCheckResult.success) {
        this.log("Warning: Device check - " + deviceCheckResult.errors.join(", ") + " - preview unavailable");
        this.previewToggle = false;
        this.updateConnectionState();
        return;
      }

      let previewTracks = [];

      if (this.hasActiveLocalTracks()) {
        previewTracks = this.localTracks;
      } else {
        try {
          previewTracks = await Video.createLocalTracks({
            audio: false,
            video: {
              width: videoWidth,
              height: videoHeight
            }
          });
        } catch (error) {
          this.log("Warning: Unable to access Camera for preview - " + (error?.message || "Unknown error"));
          this.previewToggle = false;
          this.updateConnectionState();
          return;
        }
      }

      if (previewTracks && previewTracks.length > 0) {
        this.localTracks = previewTracks;
        const previewContainer = this.getPreviewContainer();
        if (previewContainer && !previewContainer.querySelector('video')) {
          this.attachTracks(previewTracks, previewContainer);
        }
      } else {
        this.log("No camera device available for preview");
        this.previewToggle = false;
      }

      this.updateConnectionState();
    } catch (error) {
      this.log("Error in showPreview: " + (error?.message || "Unknown error"));
      this.previewToggle = false;
      this.updateConnectionState();
    }
  }

  hidePreview() {
    this.previewToggle = false;

    // Always stop and detach tracks when preview is hidden
    if (!this.activeRoom) {
      this.stopLocalTracks();
    } else {
      // If in a room, only clear the preview container but keep tracks in the room
      this.clearPreviewContainer();
    }

    this.updateConnectionState();
  }

  leaveRoom() {
    const hadActiveSession = this.activeRoom || this.localTracks.length > 0 || this.joinRoomToggle || this.previewToggle;

    if (hadActiveSession) {
      this.sendWidgetEvent(
        "SESSION_END_REQUESTED",
        "INFO",
        "User requested session termination"
      );
    }

    this.joinRoomToggle = false;
    this.previewToggle = false;
    this.connectionInProgress = false;

    if (this.activeRoom) {
      try {
        this.activeRoom.disconnect();
      } catch (e) {
        console.error("Error disconnecting room", e);
      }

      // Detach all participant tracks
      try {
        this.detachParticipantTracks(this.activeRoom.localParticipant);
        Array.from(this.activeRoom.participants.values()).forEach(participant => {
          this.detachParticipantTracks(participant);
          this.removeParticipantContainer(participant);
        });
      } catch (e) {
        console.error("Error detaching participant tracks", e);
      }

      this.activeRoom = null;
    }

    // Always stop local tracks when leaving room
    this.stopLocalTracks();
    this.clearPreviewContainer();

    this.updateConnectionState();
  }

  roomJoined(room, identity) {
    this.activeRoom = room;
    this.connectionInProgress = false;
    this.setState({ isMicrophoneMuted: false, isCameraMuted: false, participantCount: room.participants.size });
    this.updateConnectionState();

    this.log("Joined as '" + identity + "'");

    this.sendWidgetEvent(
      "ROOM_CONNECTED",
      "INFO",
      "Connected to Twilio room",
      {
        roomName: room.name,
        identity: identity
      }
    );

    const remoteMediaContainer = document.querySelector('div.twilio-video div.remote-media');

    // Attach existing participants
    room.participants.forEach(participant => {
      this.log("Already in Room: '" + participant.identity + "'");
      if (remoteMediaContainer) {
        this.participantConnected(participant, remoteMediaContainer);
      }
    });

    // Listen for new participants
    const participantConnectedHandler = (participant) => {
      this.log("Remote participant connected: '" + participant.identity + "'");

      this.sendWidgetEvent(
        "PARTICIPANT_CONNECTED",
        "INFO",
        "Remote participant connected",
        {
          participantIdentity: participant.identity
        }
      );

      this.setState({ participantCount: this.activeRoom.participants.size });

      if (remoteMediaContainer) {
        this.participantConnected(participant, remoteMediaContainer);
      }
    };

    const participantDisconnectedHandler = (participant) => {
      this.sendWidgetEvent(
        "PARTICIPANT_DISCONNECTED",
        "INFO",
        "Remote participant disconnected",
        {
          participantIdentity: participant.identity
        }
      );

      this.log("Remote participant disconnected: '" + participant.identity + "'");
      this.setState({ participantCount: this.activeRoom.participants.size });
      this.detachParticipantTracks(participant);
      this.removeParticipantContainer(participant);
    };

    const roomDisconnectedHandler = () => {
      this.log('Left the room');

      this.sendWidgetEvent(
        "ROOM_DISCONNECTED",
        "INFO",
        "Disconnected from Twilio room"
      );

      // Clean up all participants
      try {
        this.detachParticipantTracks(this.activeRoom.localParticipant);
        Array.from(this.activeRoom.participants.values()).forEach(participant => {
          this.detachParticipantTracks(participant);
          this.removeParticipantContainer(participant);
        });
      } catch (e) {
        console.error("Error cleaning up participants", e);
      }

      this.stopLocalTracks();
      this.clearPreviewContainer();

      this.activeRoom = null;
      this.joinRoomToggle = false;
      this.previewToggle = false;
      this.connectionInProgress = false;

      this.setState({ isMicrophoneMuted: false, isCameraMuted: false, participantCount: 0 });
      this.updateConnectionState();
    };

    room.once('participantConnected', participantConnectedHandler);
    room.once('participantDisconnected', participantDisconnectedHandler);
    room.once('disconnected', roomDisconnectedHandler);
  }

  handleError(message, error) {
    const fullMessage = error?.message
      ? message + ": " + error.message
      : message;

    this.connectionInProgress = false;
    console.error(fullMessage, error || "");
    this.log(fullMessage);

    this.sendWidgetEvent(
      "FATAL_ERROR",
      "ERROR",
      fullMessage,
      {
        errorName: error?.name || "",
        errorCode: error?.code || "",
        errorMessage: error?.message || ""
      }
    );

    this.updateConnectionState();
  }

  handleFocusLost() {
    if (!this.focusLost) {
      this.focusLost = true;
      this.log("Focus lost");

      this.sendWidgetEvent(
        "FOCUS_LOST",
        "WARNING",
        "Browser focus lost or page became hidden"
      );
    }
  }

  handleFocusReturned() {
    if (this.focusLost) {
      this.focusLost = false;
      this.log("Focus returned");

      this.sendWidgetEvent(
        "FOCUS_RETURNED",
        "INFO",
        "Browser focus returned or page became visible"
      );
    }
  }

  getBrowserInfo() {
    return navigator.userAgent || "";
  }

  render() {
    const { showDiagnostics, showFeatureList, participantSide } = this.props;
    const { connectionState, isMicrophoneMuted, isCameraMuted, participantCount } = this.state;
    const isConnected = connectionState === "Connected";

    return (
      <div className="twilio-video">
        <div className="twilio-controls">
          {/* Status Indicator */}
          <div className={`twilio-status-indicator ${connectionState.toLowerCase()}`}>
            <span className="twilio-status-dot"></span>
            <span className="twilio-status-text">
              {isConnected ? `Connected (${participantCount} ${participantCount === 1 ? 'participant' : 'participants'})` : connectionState}
            </span>
          </div>

          {/* Media Controls */}
          {isConnected && (
            <div className="twilio-media-controls">
              <button
                className={`twilio-control-btn twilio-microphone-btn ${isMicrophoneMuted ? 'muted' : 'active'}`}
                onClick={() => this.toggleMicrophone()}
                title={isMicrophoneMuted ? 'Unmute microphone' : 'Mute microphone'}
              >
                <span className="twilio-icon">🎤</span>
                <span className="twilio-label">{isMicrophoneMuted ? 'Muted' : 'Mic'}</span>
              </button>

              <button
                className={`twilio-control-btn twilio-camera-btn ${isCameraMuted ? 'muted' : 'active'}`}
                onClick={() => this.toggleCamera()}
                title={isCameraMuted ? 'Turn on camera' : 'Turn off camera'}
              >
                <span className="twilio-icon">📹</span>
                <span className="twilio-label">{isCameraMuted ? 'Off' : 'Camera'}</span>
              </button>
            </div>
          )}
        </div>

        <div className="media remote-media"></div>
        <div className="media local-media"></div>
        <div className="log"></div>

        {showDiagnostics === true && (
          <div className="twilio-diagnostics">
            <div><strong>ISR Secure Video Widget</strong></div>
            <div>Version: {WIDGET_VERSION}</div>
            <div>Participant side: {participantSide}</div>
            <div>Connection state: {connectionState}</div>
            <div>Twilio SDK: {TWILIO_SDK_VERSION}</div>
            <div>Browser: {this.getBrowserInfo()}</div>
          </div>
        )}

        {showFeatureList === true && (
          <div className="twilio-diagnostics">
            <div><strong>Supported Features</strong></div>
            <ul>
              {WIDGET_FEATURES.map(feature => (
                <li key={feature}>{feature}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  }
}

export default hot(TwilioVideoChat);
