import { Component, createElement } from "react";
import { hot } from "react-hot-loader/root";

import "./ui/TwilioVideoChat.css";
import { buildWidgetEvent, emitWidgetEvent } from "./services/eventLogger";
import { performDeviceCheck } from "./services/deviceService";

var Video = require('twilio-video');

var chat;
var joinRoomToggle;
var previewToggle;
var activeRoom;
//Prevent double connection 
var connectionInProgress = false;
var remoteTracks;
var localTracks;
var participantContainers = {};


var focusLost = false;

function handleFocusLost() {
  if (!focusLost) {
    focusLost = true;
    log("Focus lost");

    sendWidgetEvent(
      "FOCUS_LOST",
      "WARNING",
      "Browser focus lost or page became hidden"
    );

    executeAction("onFocusLostAction");
  }
}

function handleFocusReturned() {
  if (focusLost) {
    focusLost = false;
    log("Focus returned");

    sendWidgetEvent(
      "FOCUS_RETURNED",
      "INFO",
      "Browser focus returned or page became visible"
    );

    executeAction("onFocusReturnedAction");
  }
}

// When we are about to transition away from this page, disconnect
// from the room, if joined.
window.addEventListener('beforeunload', leaveRoom);

window.addEventListener("blur", handleFocusLost);
window.addEventListener("focus", handleFocusReturned);

document.addEventListener("visibilitychange", function() {
  if (document.hidden) {
    handleFocusLost();
  } else {
    handleFocusReturned();
  }
});

function getBooleanProp(propName, defaultValue) {
    const prop = chat && chat.props ? chat.props[propName] : null;

    if (!prop || prop.value === undefined || prop.value === null) {
        return defaultValue;
    }

    return prop.value;
}


async function joinRoom() {
  var roomName = chat.props.roomNameExpr.value;
  var identity = chat.props.nickNameExpr.value;
  var token = chat.props.accessTokenExpr.value;

  if (!roomName || !identity || !token) {
    return;
  }
  if (connectionInProgress) {
      log("Connection already in progress");
      return;
  }
  connectionInProgress = true;

  joinRoomToggle = true;

  sendWidgetEvent(
    "DEVICE_CHECK_STARTED",
    "INFO",
    "Device check started"
  );

  const deviceCheckResult = await performDeviceCheck();

  if (!deviceCheckResult.success) {
    sendWidgetEvent(
      "DEVICE_CHECK_FAILED",
      "ERROR",
      "Device check failed",
      deviceCheckResult
    );

    handleError("Device check failed", {
      name: "DeviceCheckError",
      message: deviceCheckResult.errors.join(", ")
    });

    joinRoomToggle = false;
    connectionInProgress = false;
    return;
  }

  sendWidgetEvent(
    "DEVICE_CHECK_PASSED",
    "INFO",
    "Device check passed",
    deviceCheckResult
  );

  log("Joining room '" + roomName + "'...");

  var connectOptions = {
    name: roomName,
    logLevel: "warn"
  };

  log(
    "Creating local tracks. Camera: " +
    getBooleanProp("cameraEnabledExpr", true) +
    ", Microphone: " +
    getBooleanProp("microphoneEnabledExpr", true)
  );

  var localTracksPromise = localTracks
    ? Promise.resolve(localTracks)
    : Video.createLocalTracks({
        audio: getBooleanProp("microphoneEnabledExpr", true),
        video: getBooleanProp("cameraEnabledExpr", true)
      });

  localTracksPromise.then(
    function (tracks) {
      localTracks = tracks;
      connectOptions.tracks = tracks;

      Video.connect(token, connectOptions).then(
        function (room) {
          roomJoined(room, identity);
        },
        function (error) {
          handleError("Could not connect to Twilio", error);
        }
      );
    },
    function (error) {
      handleError("Unable to access Camera and Microphone", error);
    }
  );
}

function clearPreviewContainer() {
  var previewContainer = getPreviewContainer();

  if (previewContainer) {
    while (previewContainer.firstChild) {
      previewContainer.removeChild(previewContainer.firstChild);
    }
  }
}

function stopLocalTracks() {
  if (localTracks) {
    localTracks.forEach(function(track) {
      try {
        detachTrack(track);

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

    localTracks = null;
  }

  clearPreviewContainer();
}

// Leave Room.
function leaveRoom() {
  joinRoomToggle = false;
  previewToggle = false;
  
  if (activeRoom || localTracks || joinRoomToggle || previewToggle) {
    sendWidgetEvent(
      "SESSION_END_REQUESTED",
      "INFO",
      "User requested session termination"
    );
  }

  if (activeRoom) {
    activeRoom.disconnect();
  } else {
    stopLocalTracks();
  }
  connectionInProgress = false;
}

function getPreviewContainer() {
  var selector = chat.props.previewSelector || 'div.twilio-video div.local-media';
  return document.querySelector(selector);
}

function showPreview() {
  if (!getBooleanProp("cameraEnabledExpr", true)) {
    log("Camera preview skipped - camera disabled");
    return;
  }

  previewToggle = true;

  log(
    "Creating local tracks. Camera: " +
    getBooleanProp("cameraEnabledExpr", true) +
    ", Microphone: " +
    getBooleanProp("microphoneEnabledExpr", true)
  );

  var localTracksPromise = localTracks
    ? Promise.resolve(localTracks)
   // : Video.createLocalTracks();
    : Video.createLocalTracks({
        audio: getBooleanProp("microphoneEnabledExpr", true),
        video: getBooleanProp("cameraEnabledExpr", true)
    });

  localTracksPromise.then(function(tracks) {
      localTracks = tracks;
      var previewContainer = getPreviewContainer();
      if (previewContainer && !previewContainer.querySelector('video')) {
        attachTracks(tracks, previewContainer);
      }
    },function(error) {
      //console.error('Unable to access local media', error);
      handleError("Unable to access Camera and Microphone", error);
    }
  );
};

function executeAction(actionName) {
  var action = chat && chat.props ? chat.props[actionName] : null;

  if (action && action.canExecute && !action.isExecuting) {
    action.execute();
  }
}

function sendWidgetEvent(eventType, eventLevel, message, details = {}) {

  if (!chat || !chat.props) {
    return;
  }

  const payload = buildWidgetEvent({
    eventType,
    eventLevel,
    sessionId: chat.props.roomNameExpr?.value || "",
    participantIdentity: chat.props.nickNameExpr?.value || "",
    participantSide: chat.props.participantSide || "",
    message,
    details
  });

  emitWidgetEvent({
    eventJsonAttribute: chat.props.eventJsonAttribute,
    onWidgetEvent: chat.props.onWidgetEvent,
    payload,
    logMessages: getBooleanProp("logActiveExpr", false)
  });
}

function handleError(message, error) {
  var fullMessage = error && error.message
    ? message + ": " + error.message
    : message;

  connectionInProgress = false;
  console.error(fullMessage, error || "");
  log(fullMessage);

  sendWidgetEvent(
    "FATAL_ERROR",
    "ERROR",
    fullMessage,
    {
      errorName: error && error.name ? error.name : "",
      errorCode: error && error.code ? error.code : "",
      errorMessage: error && error.message ? error.message : ""
    }
  );

  executeAction("onErrorAction");
}

function hidePreview() {
  previewToggle = false;
  clearPreviewContainer();
}

// Attach the Track to the DOM.
function attachTrack(track, container) {
  if (!track || !container || typeof track.attach !== "function") {
    return;
  }
  container.appendChild(track.attach());
}

// Attach array of Tracks to the DOM.
function attachTracks(tracks, container) {
  tracks.forEach(function(track) {
    attachTrack(track, container);
  });
}

// Detach given track from the DOM.
function detachTrack(track) {
  if (!track || typeof track.detach !== "function") {
    return;
  }

  track.detach().forEach(function(element) {
    element.remove();
  });
}


// Removes remoteParticipant container from the DOM.
function removeParticipantContainer(participant) {
  if (participant) {
    const container = participantContainers[participant.identity];

    if (container && container.parentNode) {
      container.parentNode.removeChild(container);
    }

    delete participantContainers[participant.identity];
  }
}

// A new RemoteTrack was published to the Room.
function trackPublished(publication, container) {
  if (publication.isSubscribed) {
    attachTrack(publication.track, container);
  }
  publication.on('subscribed', function(track) {
    //log('Subscribed to ' + publication.kind + ' track');
    attachTrack(track, container);
  });
  publication.on('unsubscribed', detachTrack);
}

// A RemoteTrack was unpublished from the Room.
function trackUnpublished(publication) {
  log(publication.kind + ' track was unpublished.');
}

// A new RemoteParticipant joined the Room
function participantConnected(participant, container) {
  let participantContainer = document.createElement('div');
  participantContainer.className = 'participant-container';
  container.appendChild(participantContainer);

  let tracksContainer = document.createElement('div');
  tracksContainer.className = 'participant-tracks';
  participantContainer.appendChild(tracksContainer);

  let nameContainer = document.createElement('div');
  nameContainer.className = 'participant-name';
  nameContainer.textContent = participant.identity;
  participantContainer.appendChild(nameContainer);

  participantContainers[participant.identity] = participantContainer;

  participant.tracks.forEach(function(publication) {
    trackPublished(publication, tracksContainer);
  });
  participant.on('trackPublished', function(publication) {
    trackPublished(publication, tracksContainer);
  });
  participant.on('trackUnpublished', trackUnpublished);
}

// Detach the Participant's Tracks from the DOM.
function detachParticipantTracks(participant) {
  var tracks = getTracks(participant);
  tracks.forEach(detachTrack);
}

// Get the Participant's Tracks.
function getTracks(participant) {
  return Array.from(participant.tracks.values()).filter(function(publication) {
      return publication.track;
    }).map(function(publication) {
      return publication.track;
    });
}

// Successfully connected!
function roomJoined(room, identity) {
  activeRoom = room;
  connectionInProgress = false;
  log("Joined as '" + identity + "'");

  sendWidgetEvent(
    "ROOM_CONNECTED",
    "INFO",
    "Connected to Twilio room",
    {
        roomName: room.name,
        identity: identity
    }
  );

  executeAction("onConnectedAction");

  // Attach the Tracks of the Room's Participants.
  var remoteMediaContainer = document.querySelector('div.twilio-video div.remote-media');
  room.participants.forEach(function(participant) {
    log("Already in Room: '" + participant.identity + "'");
    participantConnected(participant, remoteMediaContainer);
  });

  // When a Participant joins the Room, log the event.
  room.on('participantConnected', function(participant) {
    log("Remote participant connected: '" + participant.identity + "'");
    
    sendWidgetEvent(
      "PARTICIPANT_CONNECTED",
      "INFO",
      "Remote participant connected",
      {
          participantIdentity: participant.identity
      }
    );

    participantConnected(participant, remoteMediaContainer);
    executeAction("onParticipantConnectedAction");
  });

  // When a Participant leaves the Room, detach its Tracks.
  room.on('participantDisconnected', function(participant) {
    sendWidgetEvent(
      "PARTICIPANT_DISCONNECTED",
      "INFO",
      "Remote participant disconnected",
      {
          participantIdentity: participant.identity
      }
    );
    log("Remote participant disconnected: '" + participant.identity + "'");
    detachParticipantTracks(participant);
    removeParticipantContainer(participant);
    executeAction("onParticipantDisconnectedAction");
  });

  // Once the LocalParticipant leaves the room, detach the Tracks
  // of all Participants, including that of the LocalParticipant.
  room.on('disconnected', function() {
    log('Left the room');

    sendWidgetEvent(
      "ROOM_DISCONNECTED",
      "INFO",
      "Disconnected from Twilio room"
    );

    executeAction("onDisconnectedAction");

    detachParticipantTracks(room.localParticipant);
    room.participants.forEach(detachParticipantTracks);
    room.participants.forEach(removeParticipantContainer);
    stopLocalTracks();
    activeRoom = null;
    connectionInProgress = false;
  });
}

// Activity log.
function log(message) {
  var logActive = chat.props.logActiveExpr.value;
  if (logActive) {
    var logSelector = chat.props.logSelector || 'div.twilio-video div.log';
    var logElmnt = document.querySelector(logSelector);
    if (logElmnt) {
      logElmnt.innerHTML += '<p>' + message + '</p>';
    }
  }
}

class TwilioVideoChat extends Component {

  componentWillMount() {
    chat = this;
  }

  componentWillUnmount() {
    leaveRoom();
  }

  componentDidUpdate() {
    if (this.props.joinRoomActiveExpr.value) {
      if (!joinRoomToggle) joinRoom();
    } else {
      if (joinRoomToggle) leaveRoom();
    }

    if (this.props.previewActiveExpr.value) {
      if (!previewToggle) showPreview();
    } else {
      if (previewToggle) hidePreview();
    }
  }

  render() {
    return <div class="twilio-video">
        <div class="media remote-media"></div>
        <div class="media local-media"></div>
        <div class="log"></div>
    </div>;
  }
}

export default hot(TwilioVideoChat);
