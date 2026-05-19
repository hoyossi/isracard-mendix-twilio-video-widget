## Twilio Video Chat
A Mendix widget for video chats on the Twilio platform.

## Description
This widget provides video chat functionalities based on the Twilio platform.

As such, it can:
- Add a user to a **chat room**.
- Display **video** views with **audio** for all other **participants** in the room.
- Display a **preview** from your **local camera** on a separate box.
- Display a **log** of messages related to the events of joining and leaving the room by participants.

## Example Application
- [Here](https://github.com/ObjectivityLtd/Mendix.TwilioVideoChat/blob/master/example-app/TwilioVideoChat-SampleApp.mpk) you can find a Mendix package of a simple example app that uses this widget.
- And, here is what it looks like: [twiliovideochat-sandbox.mxapps.io](https://twiliovideochat-sandbox.mxapps.io/).

## Usage
Place the widget on a Data View which returns any entity that can provide configuration values for:
- `Room name`
- `Nickname` (identity)
- `Join room` (Boolean: on 'true', it will join the room and on ‘false’, it will leave it)
- `Access Token` string. You can generate this using a helper Java Action: `GenerateAccessToken` in our [TwilioAccessTokenGenerator](https://appstore.home.mendix.com/link/app/113743/) module.

In order to use the widget, you must have a [Twilio account](https://www.twilio.com/try-twilio) and:

- Account SID – your primary Twilio account identifier; you can find this [in the console here](https://www.twilio.com/console).
- API Key SID – used for authentication; generate one [here](https://www.twilio.com/console/runtime/api-keys).
- API Key Secret – used for authentication; generate one [here](https://www.twilio.com/console/runtime/api-keys).
