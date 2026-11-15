<p align="center">
  <img src="../build/icon.png" alt="RTMP File Streamer" width="96" height="96">
</p>

<h1 align="center">RTMP File Streamer</h1>

<div align="center">
  <p><strong>Turn a local video library into a 24/7 live channel</strong></p>
  <p><em>A desktop app that streams a local video playlist as a live channel</em></p>

  <p>
    <a href="https://github.com/ohmykreee/RTMP-File-Streamer/actions/workflows/build.yml"><img src="https://github.com/ohmykreee/RTMP-File-Streamer/actions/workflows/build.yml/badge.svg" alt="Build"></a>
    <img src="https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-3B82F6?style=flat" alt="Windows / Linux / macOS">
    <a href="https://github.com/ohmykreee/RTMP-File-Streamer/releases"><img src="https://img.shields.io/github/v/release/ohmykreee/RTMP-File-Streamer?style=flat&color=3B82F6" alt="Release"></a>
    <a href="../LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=flat" alt="MIT license"></a>
  </p>

  <p>
    <a href="../README.md">简体中文</a> · <strong>English</strong> · <a href="README.ja.md">日本語</a>
  </p>
</div>

---

This app streams local video files back to back in playlist order. Each file (with external or embedded subtitles) is re-encoded to your settings and pushed live — handy for running a local library as a 24-hour channel. Supports RTMP / RTMPS, SRT, RTSP and WebRTC (WHIP).

## Interface

| Area | Contents |
|---|---|
| Playlist | "+ Video" or drag files in; drag to reorder, remove items, clear all; each row shows its status and subtitle entry |
| Settings | Five tabs — Video encoding / Audio encoding / Subtitles / Output / Advanced — with the preset bar on top |
| Player | The whole playlist as one progress bar, current file and position, encoder and network stats, Start / Stop / Next file |
| Run log | Bottom panel: filter by level, auto-scroll, clear |

The divider between the playlist and settings is draggable. The language button is at the far right of the top bar; the same language and appearance settings live under Advanced → Interface.

## Installation

1. Download the archive for your platform and extract it to a **writable folder** (not `C:\Program Files` or another read-only location).
2. Run the app: `RTMPFileStreamer.exe` on Windows, `rtmp-file-streamer` on Linux, or `RTMP File Streamer.app` on macOS.
3. All state lives in `Data/` inside the application folder; the whole folder can be copied or moved to a USB drive.
4. FFmpeg + FFprobe must be available (see Requirements). FFmpeg is not bundled; you can also drop `ffmpeg` / `ffprobe` into `bin/` in the application folder (`resources/bin/` in the packaged build).

## Quick start

1. Launch the app and check that the FFmpeg version appears in the top-right corner; if it says "FFmpeg not found", set the path under Advanced.
2. On the Output tab, pick a protocol, enter the address and stream key (optional), and click "Test connection".
3. Adjust the encoding settings (Video encoding and the other tabs), or pick a built-in preset; click "Save as preset" when you are happy.
4. Click "+ Video" to add files (multi-select) or drag them into the playlist; subtitles with the same name in the same folder are attached automatically.
5. If needed, expand a row's subtitle and sync settings and choose the subtitle track, handling mode and delays.
6. Click "Start streaming" (or press `Space`). While streaming you can drag the progress bar to jump or click "Next file"; click "Stop" to finish.

## Playlist and subtitles

- Reads duration, resolution, frame rate, audio/video tracks and embedded subtitle tracks for every file.
- Attaches same-folder subtitles automatically: `movie.srt`, `movie.zh-CN.ass`, `movie.forced.srt`, plus `Subs/` and `字幕/` subfolders.
- Each row can choose its own subtitle track (embedded #N or an external file), handling mode, A/V delay and subtitle delay.
- Supported external subtitles: `.srt` `.ass` `.ssa` `.vtt` `.sub` `.idx` `.sup`. Text subtitles can be burned in; bitmap subtitles such as `.sup` / `.idx` are detected and attached but **cannot be burned in** — the app warns and skips them.
- Row status: Pending / Preparing / Streaming / Completed / Skipped / Error. These describe **what viewers are seeing**, not where the encoder is: the encoder runs ahead, so a file that is already encoded but not yet aired shows "Preparing".
- The playlist and all settings are saved automatically, restored on the next launch and re-validated. Non-video files dropped alongside are ignored and logged.

## Encoding and presets

| Category | Options |
|---|---|
| Video | H.264 / H.265 / AV1 / Copy as-is; encoder (automatic hardware preference, or AMF / NVENC / QSV / libx264 / libx265 / SVT-AV1 / libaom); CBR / VBR / ABR / CRF; bitrate, maximum bitrate, buffer size, CRF, preset, tune, profile, resolution, frame rate, keyframe interval, B-frames, pixel format |
| Audio | AAC / MP3 / Opus / Copy / No audio; bitrate, sample rate, channels, CBR / VBR, loudness normalization (loudnorm −16 LUFS) |
| Subtitles | Off / Burn into the picture / Copy as a separate track; style source (keep the original ASS style / force override / plain text), font, size, colour, outline, shadow, vertical margin, alignment, bold / italic |

**Resolution**: with "Scale output" off the source resolution is kept. With it on, enter width and height or pick 4K / 2K / 1080p / 900p / 720p / 480p / 360p. Width and height are rounded to even values; with "Auto height" checked the height is derived from the source aspect ratio by FFmpeg.

**Bitrate units**: video bitrate, maximum bitrate and buffer size have a `kbps / Mbps` dropdown; audio bitrate is in kbps.

**CRF**: the maximum bitrate still applies as a ceiling, so the stream stays predictable.

The preset bar offers a dropdown (built-in presets / my presets) plus "Save as preset", "Rename", "Delete" and "Data folder".

- Saving writes the Video encoding, Audio encoding, Subtitles and Output tab settings into one named preset; language, appearance, logs and the FFmpeg path on the Advanced tab are not part of a preset.
- A built-in preset changes encoding-related settings only; it never overwrites the push address, stream key or obs-websocket configuration.
- **A user preset restores the full configuration**, including the push target, which is stored in plain text.
- Saving with an existing name overwrites it; after any manual change the dropdown falls back to "(Custom)".
- Rename only changes the name: the preset id, contents and current selection stay the same. Built-in presets cannot be renamed or deleted.

## Streaming

The protocol determines the address format, the container and how the stream key is used:

| Protocol | Address example | How the stream key is used |
|---|---|---|
| RTMP / RTMPS | `rtmp://live.example.com/app/` | Appended to the end of the address |
| SRT | `srt://live.example.com:9000` | Appended to the end; for encryption, put the passphrase in the stream key field |
| RTSP | `rtsp://live.example.com:8554/live` | Appended to the address path |
| WebRTC / WHIP | `https://live.example.com/whip/endpoint` | Sent as a Bearer token |

- The address field **detects the protocol when it loses focus** and switches the dropdown; you can still change it afterwards. Starting or testing is blocked while the address and protocol do not match.
- Address and number fields apply when you leave the field; the stream key, extra arguments, text and colour fields apply immediately.
- The address may be empty; "Start streaming" stays disabled while it is, and the app never puts the example address back.
- The stream key is masked (click "Show" to reveal it temporarily). The key is stored in plain text in local settings and presets; **the UI and logs never show the full target** — only the server address, with the key replaced by `***`.
- The container follows the protocol (RTMP → FLV, SRT → MPEG-TS, RTSP / WHIP use their own protocols); there is no separate container option.
- **"Test connection"** pushes a 5-second test picture with the current encoding settings and reports the server's own response plus a diagnosis; it gives up on time when the server does not answer.
  - The test shares the encoder, rate control, sample rate, channels, loudness normalization, frame rate, keyframe interval, pixel format, protocol and custom arguments with a real stream.
  - The test picture is synthetic: with scaling on it is generated at the target size and capped at 1280×720; with scaling off it is 640×360. When video / audio is set to "Copy as-is" or "No audio" the test has no source to copy and falls back to software encoding or really sends no audio. Subtitle burning and copying are out of scope. These differences are listed in the result.
- **"View FFmpeg command"** copies the command line generated from the current settings. With buffered streaming on the app runs an encoder and a publisher; the preview shows the equivalent single-process command and says so.
- Automatic reconnect (attempts / interval configurable): the single-process pipeline resumes near the break; buffered streaming rebuilds the session from where viewers currently are.
- **Settings and playlist edits are locked while streaming**: the settings panel, preset bar and playlist add / reorder / clear / subtitle edits are frozen; jump, skip, stop and the log stay available, and everything unlocks when streaming stops.

### Common addresses

| Platform / protocol | Address format |
|---|---|
| Local nginx-rtmp / SRS (RTMP) | `rtmp://127.0.0.1/live/` + your own key |
| YouTube Live (RTMP) | `rtmp://a.rtmp.youtube.com/live2/` + stream key |
| Twitch (RTMP) | `rtmp://live.twitch.tv/app/` + stream key |
| Bilibili (RTMP) | `rtmp://live-push.bilivideo.com/live-bvc/` + stream key (including the `?` parameters; paste the whole thing into the key field) |
| SRT receiver | `srt://receiver.example.com:9000` + passphrase (in the key field) |
| RTSP server | `rtsp://receiver.example.com:8554/live` + key (as required by the server) |
| WHIP endpoint | `https://receiver.example.com/whip/endpoint` + token |

> The final RTMP / RTSP target is the address verbatim plus the key verbatim (the app inserts no separator), so whether the address ends with `/` depends on the platform.

## Buffered streaming

- On by default: the encoder runs at full speed and the publisher outputs at 1×; the encoder may run up to the "encoding lead" (12–300 s) ahead, and is paused beyond that.
- Every second of lead is held in memory, so a larger lead uses more memory. The 12-second minimum exists because a file change itself takes a few seconds; anything smaller interrupts the stream at every file boundary.
- With it on, the thin green bar at the bottom of the progress bar shows the encoder position. With it off, every file re-opens the publishing session, and "Real-time pacing" and "Drop late frames" only apply then.

## Progress and switching

- The **whole playlist** is drawn as one progress bar: one segment per file, finished segments turn green, the current one is highlighted, and segments are separated by dividers.
- **Draggable**: while dragging, only the target file name is shown; releasing jumps to the **start of that file**. A live stream cannot recall frames already sent, and the app offers no in-file seeking; releasing inside the current file does nothing.
- With buffered streaming on, a **thin green bar** runs along the bottom edge and shows how far encoding has gone; the gap between it and the blue bar is the encoding lead — exactly what a jump has to throw away.
- **"Next file"** switches to the next segment immediately (shortcut `Ctrl+→`).
- The icon buttons at the right of each row, left to right: start streaming from this file / jump to this file, subtitle and sync settings, remove.
- The status line below shows the current file and position / duration, encoder speed / bitrate / fps, buffer lead, measured network rate, dropped frames and elapsed time; it is hidden while idle.
- When a stream ends (playlist finished or stopped manually) the progress resets to zero.

## Language, appearance and logs

- The language button at the far right of the top bar (globe icon + current language code) lists 中文 / 日本語 / English, with a check mark on the current one; the same choice is under Advanced → Interface.
- On first launch the language follows the system locale: Chinese (Simplified or Traditional) → Chinese; Japanese → Japanese; **everything else → English**.
- An explicit switch takes effect immediately and is saved; the app stops following the system locale from then on. Until you switch explicitly, launch keeps following the system locale. The language covers the interface, window title, native file dialogs, and the run log and error messages.
- **Appearance**: Light / Dark / Follow the system (default). With "Follow the system" the app follows the OS light/dark setting live, including the window background. Language and appearance are application settings: they are not written into the playlist or into presets.
- The run log panel filters by Debug / Info / Warning / Error / FFmpeg, can auto-scroll and can be cleared; it says so when a filter matches nothing.
- **Log retention**: logs are written to `Data/Logs/session-*.log`. A file over 4 MB rolls to a new one; when the total exceeds 12 MB or there are more than 20 files, the oldest are deleted.
- Hardware encoders get a **real usability check**: a few frames are actually encoded to verify the driver works, not just listed by name.
- Shortcuts: `Space` starts streaming (not captured while focus is on a button / switch / input), `Ctrl+→` goes to the next file. Closing the window while streaming asks whether to stop and close or keep streaming.

## Requirements

| Dependency | Notes |
|---|---|
| **FFmpeg + FFprobe** | Required. Lookup order: the path set in Settings → `bin/` in the application folder (`resources/bin/` in the packaged build) → `PATH` → common install locations. Use a full build with subtitle filter support, or text subtitles cannot be burned in. |
| Operating system | Windows 10/11 x64 (verified); macOS / Linux are supported too; arm64 builds are provided for Windows / Linux, and an Apple-silicon build for macOS. |

## Known limitations

- **A jump re-opens the publishing session**: a live stream cannot recall frames that were already sent. The buffered content queues behind what viewers have not watched yet, so it has to be dropped and the session re-opened — expect about 1–3 seconds of interruption (viewers see a reconnect). How much is dropped depends on the "encoding lead" setting, up to nearly 5 minutes. With buffered streaming on (the default) a file that plays to its natural end only restarts the encoder and viewers stay connected; with buffered streaming off, every file re-opens the publishing session.
- **The encoding lead is not viewer latency**: it caps how far ahead of the publisher the encoder may run (12–300 s), so a slow encoder does not starve the publisher. The cost is memory — every second of lead is held in the app, so a larger lead uses more memory. The 12-second minimum exists because changing files already takes a few seconds; anything smaller interrupts the stream at every file boundary.
- **A positive A/V delay leaves silence at the start**: the content shifts later, so the stream begins with a gap of that length. To correct A/V sync, prefer a negative value (trim the start). The subtitle delay only affects burned-in text subtitles; copying a subtitle track or using bitmap subtitles ignores it and warns.
- **Bitmap subtitles cannot be burned in**: embedded PGS / DVD / DVB and external `.sup` / `.idx` can only be handled as a subtitle track. Use a text subtitle instead; the panel says so when a bitmap track is selected and set to "Burn into the picture".
- **A separate subtitle track only works in containers that support it, such as MPEG-TS**: FLV and WebRTC do not carry a separate subtitle track; burn the subtitles in instead. Copying a subtitle track is also unsupported while buffered streaming is on.
- **Copying requires the source codec to be compatible with the target container**: for example VP9 / AV1 video copied into FLV, or AC-3 / DTS audio copied into FLV, is not supported and the app warns. AV1 video also cannot be relayed through MPEG-TS: with buffered streaming on it automatically switches to the single-process pipeline, and MPEG-TS targets such as SRT do not support AV1.
- **Opus has poor compatibility in FLV**: AAC is the default; choosing Opus shows a warning. WebRTC (WHIP) requires Opus audio and H.264 video.
- **Files without an audio or video track get one generated**: when the source has no audio (and the audio codec is not set to "Copy the source audio" or "No audio"), the app encodes silence with the current audio settings; when it has no usable video (and the video codec is not set to "Copy as-is"), it encodes black frames with the current video settings (1280×720 when scaling is off). The stream always carries both tracks, so a server never rejects it as a single-track stream.
- **Cover art is not video**: album art in music / audio files is skipped and never pushed as the picture; a file that only contains cover art gets black frames as above.
- **No pause and no in-file seeking**: resuming would mean re-opening the publishing session, which interrupts the stream just like a jump, so neither is offered. `Space` only starts streaming.
- **Real-time pacing and Drop late frames only apply with buffered streaming off**: with buffered streaming on, the publisher always outputs at 1×, and the UI says so next to those switches.
- **The application folder must be writable**: state lives in `Data/` inside it, so do not put it in a read-only location such as `C:\Program Files`. The app still runs there, but settings and presets cannot be saved and the log reports an error.
- **The playlist uses absolute paths**: after moving the application folder, settings and presets still work, but playlist entries break if the drive letter or machine changed, and those files have to be added again.

## Data and backup

All state (settings / playlist / presets / logs) lives in the **`Data` folder inside the application folder**; the normal run never uses the roaming configuration directory:

| File | Contents |
|---|---|
| `Data/settings.json` | FFmpeg paths, interface language and appearance, playlist width, current session settings |
| `Data/playlist.json` | The playlist, restored on the next launch |
| `Data/presets.json` | User presets (with the push target in plain text) |
| `Data/Logs/` | Retained run logs |
| `Data/Cache/` | Cache and temporary data |

> `settings.json` and `presets.json` store the push address and stream key in plain text. Do not share them publicly, commit them or send them to anyone together with the app.

Being portable, the whole application folder (including `Data/`) can be **copied or moved to a USB drive** and used on another machine after extracting; the absolute paths in the playlist must still be valid, or the files must be added again.

- **No external state is imported**: the first launch starts fresh and never pulls settings from elsewhere on the system.
- **Moving to another machine**: copy the whole application folder.
- **Factory reset**: delete the `Data/` folder; it is recreated on the next launch.

## License

[MIT](../LICENSE). The interface is built with MIT-licensed shadcn/ui, icons come from ISC-licensed Lucide, and the Geist font is used under the SIL Open Font License 1.1.
