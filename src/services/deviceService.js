export async function performDeviceCheck() {

    const result = {
        success: true,
        errors: [],
        warnings: [],
        details: {
            https: false,
            mediaDevicesSupported: false,
            cameraCount: 0,
            microphoneCount: 0
        }
    };

    // HTTPS check
    result.details.https =
        window.location.protocol === "https:" ||
        window.location.hostname === "localhost";

    if (!result.details.https) {
        result.success = false;
        result.errors.push("HTTPS_REQUIRED");
    }

    // Browser support
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
        result.success = false;
        result.errors.push("MEDIA_DEVICES_NOT_SUPPORTED");
        return result;
    }

    result.details.mediaDevicesSupported = true;

    try {

        const devices = await navigator.mediaDevices.enumerateDevices();

        const cameras = devices.filter(
            d => d.kind === "videoinput"
        );

        const microphones = devices.filter(
            d => d.kind === "audioinput"
        );

        result.details.cameraCount = cameras.length;
        result.details.microphoneCount = microphones.length;

        if (cameras.length === 0) {
            result.success = false;
            result.errors.push("CAMERA_NOT_FOUND");
        }

        if (microphones.length === 0) {
            result.success = false;
            result.errors.push("MICROPHONE_NOT_FOUND");
        }

    } catch (error) {

        result.success = false;

        result.errors.push(
            error && error.message
                ? error.message
                : "DEVICE_ENUMERATION_FAILED"
        );
    }

    return result;
}