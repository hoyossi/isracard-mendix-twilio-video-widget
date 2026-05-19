import { Component, createElement } from "react";
import { hot } from "react-hot-loader/root";

import "./ui/TwilioVideoChat.css";

var Video = require('twilio-video');

var chat;
var joinRoomToggle;
var previewToggle;
var activeRoom;
var remoteTracks;
var localTracks;
var participantContainers = {};

// When we are about to transition away from this page, disconnect
// from the room, if joined.
window.addEventListener('beforeunload', leaveRoom);

function joinRoom() {
  var roomName = chat.props.roomNameExpr.value;
  var identity = chat.props.nickNameExpr.value;
  var token = chat.props.accessTokenExpr.value;
  if (!roomName || !identity || !token) {
    return;
  }

  joinRoomToggle = true;

  log("Joining room '" + roomName + "'...");
  var connectOptions = {
    name: roomName,
    logLevel: 'warn' // 'debug'
  };

  if (remoteTracks) {
    connectOptions.tracks = remoteTracks;
  }

  // Join the Room with the token from the server and the
  // LocalParticipant's Tracks.
  Video.connect(token, connectOptions).then(
    function (room) {
      roomJoined(room, identity);
    },
    function(error) {
      log('Could not connect to Twilio: ' + error.message);
    }
  );
};

// Leave Room.
function leaveRoom() {
  joinRoomToggle = false;

  if (activeRoom) {
    activeRoom.disconnect();
  }
}

function getPreviewContainer() {
  var selector = chat.props.previewSelector || 'div.twilio-video div.local-media';
  return document.querySelector(selector);
}

function showPreview() {
  previewToggle = true;

  var localTracksPromise = localTracks
    ? Promise.resolve(localTracks)
    : Video.createLocalTracks();

  localTracksPromise.then(function(tracks) {
      localTracks = tracks;
      var previewContainer = getPreviewContainer();
      if (previewContainer && !previewContainer.querySelector('video')) {
        attachTracks(tracks, previewContainer);
      }
    },function(error) {
      console.error('Unable to access local media', error);
      log('Unable to access Camera and Microphone');
    }
  );
};


function hidePreview() {
  previewToggle = false;
  var previewContainer = getPreviewContainer();
  if (previewContainer) {
    var previewVideo = previewContainer.querySelector('video');
    var previewAudio = previewContainer.querySelector('audio');
    if (previewVideo) { previewContainer.removeChild(previewVideo); }
    if (previewAudio) { previewContainer.removeChild(previewAudio); }
  }
};

// Attach the Track to the DOM.
function attachTrack(track, container) {
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
  track.detach().forEach(function(element) {
    element.remove();
  });
}


// Removes remoteParticipant container from the DOM.
function removeParticipantContainer(participant) {
  if (participant) {
    const container = participantContainers[participant.identity];//todo:remove dict key
    container.parentNode.removeChild(container);
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

  log("Joined as '" + identity + "'");

  // Attach the Tracks of the Room's Participants.
  var remoteMediaContainer = document.querySelector('div.twilio-video div.remote-media');
  room.participants.forEach(function(participant) {
    log("Already in Room: '" + participant.identity + "'");
    participantConnected(participant, remoteMediaContainer);
  });

  // When a Participant joins the Room, log the event.
  room.on('participantConnected', function(participant) {
    log("Joining: '" + participant.identity + "'");
    participantConnected(participant, remoteMediaContainer);
  });

  // When a Participant leaves the Room, detach its Tracks.
  room.on('participantDisconnected', function(participant) {
    log("RemoteParticipant '" + participant.identity + "' left the room");
    detachParticipantTracks(participant);
    removeParticipantContainer(participant);
  });

  // Once the LocalParticipant leaves the room, detach the Tracks
  // of all Participants, including that of the LocalParticipant.
  room.on('disconnected', function() {
    log('Left the room');
    if (remoteTracks) {
      remoteTracks.forEach(function(track) {
        track.stop();
      });
      remoteTracks = null;
    }
    detachParticipantTracks(room.localParticipant);
    room.participants.forEach(detachParticipantTracks);
    room.participants.forEach(removeParticipantContainer);
    activeRoom = null;
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
