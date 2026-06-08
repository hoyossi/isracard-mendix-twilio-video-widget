export async function performDeviceCheck(options = {}) {
    const requireCamera = options.requireCamera === true;
    const requireMicrophone = options.requireMicrophone === true;

    const result = {
        success: true,
        errors: [],
        warnings: [],
        details: {
            https: false,
            mediaDevicesSupported: false,
            cameraCount: 0,
            microphoneCount: 0,
            deviceLabelsAvailable: false,
            requireCamera,
            requireMicrophone
        }
    };

    result.details.https =
        window.location.protocol === "https:" ||
        window.location.hostname === "localhost";

    if (!result.details.https) {
        result.success = false;
        result.errors.push("HTTPS_REQUIRED");
    }

    if (!navigator.mediaDevices) {
        result.success = false;
        result.errors.push("MEDIA_DEVICES_NOT_SUPPORTED");
        return result;
    }

    result.details.mediaDevicesSupported = true;

    if (!navigator.mediaDevices.enumerateDevices) {
        result.warnings.push("DEVICE_ENUMERATION_NOT_SUPPORTED");
        return result;
    }

    try {
        const devices = await navigator.mediaDevices.enumerateDevices();

        const cameras = devices.filter(d => d.kind === "videoinput");
        const microphones = devices.filter(d => d.kind === "audioinput");

        result.details.cameraCount = cameras.length;
        result.details.microphoneCount = microphones.length;

        result.details.deviceLabelsAvailable = devices.some(
            d => d.label && d.label.length > 0
        );

        if (cameras.length === 0 && requireCamera) {
            result.success = false;
            result.errors.push("NO_CAMERA_DEVICE_FOUND");
        }

        if (microphones.length === 0 && requireMicrophone) {
            result.success = false;
            result.errors.push("NO_MICROPHONE_DEVICE_FOUND");
        }

    } catch (error) {
        result.warnings.push(
            error && error.message
                ? error.message
                : "DEVICE_ENUMERATION_FAILED"
        );
    }

    return result;
}