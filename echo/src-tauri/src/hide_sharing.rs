#[cfg(windows)]
use windows::Win32::{
    Foundation::{HWND, LPARAM, BOOL},
    UI::WindowsAndMessaging::{
        EnumWindows, GetWindowTextLengthW, GetWindowTextW, ShowWindow, SW_HIDE,
    },
};

#[cfg(windows)]
unsafe extern "system" fn enum_windows_cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
    // Look for the Windows screen sharing indicator by window title heuristics.
    let len = GetWindowTextLengthW(hwnd);
    if len == 0 {
        return BOOL(1);
    }
    let mut buffer: Vec<u16> = vec![0; (len + 1) as usize];
    let written = GetWindowTextW(hwnd, &mut buffer);
    if written == 0 {
        return BOOL(1);
    }
    let title = String::from_utf16_lossy(&buffer[..written as usize]);
    let patterns = [
        "is sharing your screen",
        "is sharing your window",
        "is sharing your display",
        "is sharing a window",
    ];
    if patterns.iter().any(|p| title.contains(p)) {
        let ptr = lparam.0 as *mut HWND;
        if !ptr.is_null() {
            *ptr = hwnd;
        }
        return BOOL(0);
    }
    BOOL(1)
}

#[cfg(windows)]
pub fn run(_app: tauri::AppHandle) -> Result<(), String> {
    unsafe {
        let mut target: HWND = HWND(std::ptr::null_mut());
        let param = LPARAM(&mut target as *mut _ as isize);
        let _ = EnumWindows(Some(enum_windows_cb), param);
        if !target.0.is_null() {
            let _ = ShowWindow(target, SW_HIDE);
        }
    }
    Ok(())
}

