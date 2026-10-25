// Prevents an additional console window on Windows in release; the TS app had
// the same property via electron-builder.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    rtmp_file_streamer::run()
}
