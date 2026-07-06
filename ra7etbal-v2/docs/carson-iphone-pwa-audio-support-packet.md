# Carson iPhone PWA Audio Support Packet

Status: Regression 1 remains open. Voice is unsafe/beta on iPhone Home Screen PWA until audio quality is production usable.

## Production

- URL: https://www.ra7etbal.com
- App surface: iPhone Home Screen PWA, standalone display mode
- Voice layer: ElevenLabs hosted agent via `@elevenlabs/react` `Conversation.startSession`

## SDK Versions

- `@elevenlabs/react`: `1.9.0`
- `@elevenlabs/client`: `1.14.0` transitive from `@elevenlabs/react`
- `webrtc-adapter`: `9.0.6`

## Commits Tried

- `9562d65`: teardown guard for overlapping sessions
- `1e02bd7`: iOS mic warm-up and `connectionDelay` mitigation
- `18711586`: ElevenLabs SDK upgrade
- `1b4223f`: invalid transcript guard so junk capture cannot execute tools

## Exact Symptoms

- Printer/machine noise remains present after force-quit/reopen.
- It sounds like machines working around Carson.
- Voice quality is not production usable.
- Transcript can become `"..."`.
- Carson sometimes hears partial phrases only.
- `"Ask Suresh to call me"` can become `"Call me"`.

## Open Source Questions

1. ElevenLabs output playback distortion.
2. Microphone input capture distortion.
3. iOS PWA audio-route conflict.
4. Greeting/playback overlapping with listening.
5. ElevenLabs hosted agent/audio pipeline issue.

## Production Diagnostics

Open the PWA with:

```text
https://www.ra7etbal.com/?carson_audio_diag=1
```

Then run:

1. `Speaker test`
   - Uses local Web Audio only.
   - If this tone is noisy, the issue is likely device/output route level, not ElevenLabs-specific.
   - If clean while Carson is noisy, evidence shifts toward ElevenLabs playback/WebRTC/hosted pipeline.

2. `Mic loopback`
   - Records a local 2-second mic sample and plays it back locally.
   - If this is noisy, evidence shifts toward mic capture or iOS audio route.
   - If clean while Carson is noisy, evidence shifts away from raw mic capture.

3. Start Carson and reproduce the noise.

4. Tap `Copy packet`.
   - Packet includes environment, mode transitions, media element state, local probe results, SDK versions, commits tried, and recent Carson diagnostics.
   - It does not upload audio.

## Reproduction Steps

1. Force-quit the iPhone Home Screen PWA.
2. Open Ra7etBal from the Home Screen icon.
3. If testing diagnostics, use `https://www.ra7etbal.com/?carson_audio_diag=1` first, then keep using the installed PWA session.
4. Tap `Speaker test`; note whether clean/noisy.
5. Tap `Mic loopback`; speak for 2 seconds; note whether playback is clean/noisy.
6. Tap `Talk to Carson`.
7. Wait for the greeting / first response.
8. Say: `Ask Suresh to call me`.
9. Note whether machine noise starts during greeting, listening, speaking, or throughout.
10. Tap `Copy packet` after the noisy session.

## Expected Safe Behavior While Open

- If transcript capture is empty, `"..."`, punctuation-only, or clipped to `"Call me"`, Carson must say: `I didn't catch that. Please say it again.`
- No client tool should execute from an invalid capture.
- iPhone PWA voice remains labeled beta until production audio is clean.
