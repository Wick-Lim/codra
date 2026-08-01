# Firebase App Check deployment matrix

Firebase Authentication App Check enforcement is disabled for this MVP. The
raw browser/device bootstrap and Electron login/App Check bootstrap boundaries
perform their own proof checks and do not use callable-only App Check options.

The `demo-codra` remote-test build uses the Firebase emulators and never embeds
production origins. Production browser and operational callable surfaces may
enable Firestore/App Check enforcement only after their provider initialization
tests pass. The production desktop App Check Web App ID must be separately
provisioned and operator-approved; it must not equal the Hosting/Google bridge
Web App ID. No secret or App Check credential belongs in this repository.
