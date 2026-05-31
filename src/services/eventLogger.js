export function buildWidgetEvent({
    eventType,
    eventLevel = "INFO",
    sessionId = "",
    participantIdentity = "",
    participantSide = "",
    message = "",
    details = {}
}) {
    return {
        eventType,
        eventLevel,
        sessionId,
        participantIdentity,
        participantSide,
        message,
        timestamp: new Date().toISOString(),
        details
    };
}

export function emitWidgetEvent({
    eventJsonAttribute,
    onWidgetEvent,
    payload,
    logMessages = false
}) {
    const json = JSON.stringify(payload);

    if (logMessages) {
        console.log("[TwilioVideoWidget Event]", payload);
    }

    if (eventJsonAttribute && eventJsonAttribute.setValue) {
        eventJsonAttribute.setValue(json);
    }

    if (onWidgetEvent && onWidgetEvent.canExecute) {
        onWidgetEvent.execute();
    }
}