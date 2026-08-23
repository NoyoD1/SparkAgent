/**
 * ADR-0022 v3.2 (2026-08-23): webview 截图 (agent "识图" 工具)
 *
 * 背景: agent 之前只能调 web_navigate / web_get_text 拿 text, 看不到 webview
 *   视觉内容. 带 vision 的 model 想看图 (例如判断 webview 上是否渲染了某个 UI,
 *   抓 SVG/icon/canvas 图像), 需要截图工具.
 *
 * 实现: Windows API PrintWindow + BGRA bitmap → PNG bytes.
 *   - PrintWindow(hwnd, mem_dc, PW_RENDERFULLCONTENT=0x2) 是 webview2 的标准截图法
 *     (不传 0x2 只能截到空白 — WebView2 是 GPU 合成层, 默认 GDI 截不到)
 *   - bitmap 是 BGRA (top-down), 编码 PNG 前 swap 通道
 *
 * 跨平台: 暂只 Windows (其他平台 future PR). 函数返回 Result<Vec<u8>> (PNG bytes).
 */
#[cfg(windows)]
pub fn screenshot_hwnd_png(hwnd_isize: isize, width: i32, height: i32) -> Result<Vec<u8>, String> {
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
        ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
    };
    // PrintWindow 在 Storage::Xps (Windows API 历史: 来自 print spooler)
    use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
    use windows::Win32::UI::WindowsAndMessaging::GetClientRect;

    if width <= 0 || height <= 0 {
        return Err(format!("invalid size: {width}x{height}"));
    }
    let hwnd = HWND(hwnd_isize as *mut std::ffi::c_void);
    unsafe {
        // 0. 二次确认 client area (decorations=true 时 client 跟 outer 可能差 30+ px)
        let mut rect = RECT::default();
        let _ = GetClientRect(hwnd, &mut rect);
        let cw = rect.right - rect.left;
        let ch = rect.bottom - rect.top;
        // 优先用 GetClientRect 的 (client area), 如果返 0 用 caller 传的 outer_size
        let (width, height) = if cw > 0 && ch > 0 {
            (cw, ch)
        } else {
            (width, height)
        };

        // 1. 创建设备上下文 (memory DC + compatible bitmap)
        let screen_dc = GetDC(hwnd);
        if screen_dc.is_invalid() {
            return Err("GetDC failed (hwnd invalid?)".into());
        }
        let mem_dc = CreateCompatibleDC(screen_dc);
        let bitmap = CreateCompatibleBitmap(screen_dc, width, height);
        let old_obj = SelectObject(mem_dc, bitmap);

        // 2. PrintWindow: PW_RENDERFULLCONTENT (0x2) + PW_CLIENTONLY (0x1) = 0x3
        //    PW_RENDERFULLCONTENT: WebView2 自己渲染到 DC (GPU 合成层需要)
        //    PW_CLIENTONLY: 只截 client area, 不含 title bar 装饰
        let _ = PrintWindow(hwnd, mem_dc, PRINT_WINDOW_FLAGS(0x3));

        // 3. bitmap → BGRA buffer (32bpp top-down, negative biHeight)
        let mut bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                biHeight: -height, // negative = top-down DIB
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut buffer: Vec<u8> = vec![0u8; (width as usize) * (height as usize) * 4];
        let lines = GetDIBits(
            mem_dc,
            bitmap,
            0,
            height as u32,
            Some(buffer.as_mut_ptr() as *mut _),
            &mut bmi,
            DIB_RGB_COLORS,
        );
        if lines == 0 {
            // cleanup
            SelectObject(mem_dc, old_obj);
            let _ = DeleteObject(bitmap);
            let _ = DeleteDC(mem_dc);
            ReleaseDC(hwnd, screen_dc);
            return Err(format!("GetDIBits failed (lines=0) for hwnd={hwnd_isize} {width}x{height}"));
        }

        // 4. 清理 GDI 资源
        SelectObject(mem_dc, old_obj);
        let _ = DeleteObject(bitmap);
        let _ = DeleteDC(mem_dc);
        ReleaseDC(hwnd, screen_dc);

        // 5. BGRA → RGBA 通道 swap, 编码 PNG
        for chunk in buffer.chunks_exact_mut(4) {
            chunk.swap(0, 2); // B ↔ R
        }
        encode_png(&buffer, width as u32, height as u32)
    }
}

#[cfg(windows)]
fn encode_png(rgba: &[u8], width: u32, height: u32) -> Result<Vec<u8>, String> {
    use png::ColorType;
    let mut out = Vec::with_capacity(rgba.len() / 4);
    {
        let mut encoder = png::Encoder::new(&mut out, width, height);
        encoder.set_color(ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder
            .write_header()
            .map_err(|e| format!("png write_header: {e}"))?;
        writer
            .write_image_data(rgba)
            .map_err(|e| format!("png write_image_data: {e}"))?;
    }
    Ok(out)
}

#[cfg(not(windows))]
pub fn screenshot_hwnd_png(_hwnd_isize: isize, _width: i32, _height: i32) -> Result<Vec<u8>, String> {
    Err("screenshot only implemented for Windows".into())
}
