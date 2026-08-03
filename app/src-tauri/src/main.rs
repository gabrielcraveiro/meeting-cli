// Esconde o console do Windows em release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    meeting_app_lib::run()
}
