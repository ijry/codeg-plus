use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Debug, Deserialize)]
struct PluginRequest {
    method: String,
    #[serde(default)]
    payload: Value,
}

fn handle_request(method: &str, payload: Value) -> Result<Value, String> {
    match method {
        "poll_events" => Ok(json!({
            "events": codeg_lib::otools_bridge::poll_events_blocking()?,
        })),
        _ => codeg_lib::otools_bridge::invoke_blocking(method, payload),
    }
}

#[no_mangle]
pub extern "C" fn otools_plugin_invoke(
    input_ptr: *const u8,
    input_len: usize,
    output_len: *mut usize,
) -> *mut u8 {
    if input_ptr.is_null() || output_len.is_null() {
        return std::ptr::null_mut();
    }

    let input = unsafe { std::slice::from_raw_parts(input_ptr, input_len) };
    let request = match serde_json::from_slice::<PluginRequest>(input) {
        Ok(value) => value,
        Err(error) => {
            return write_response(
                json!({
                    "ok": false,
                    "error": format!("Invalid input: {error}"),
                }),
                output_len,
            );
        }
    };

    let response = match handle_request(&request.method, request.payload) {
        Ok(data) => json!({ "ok": true, "data": data }),
        Err(error) => json!({ "ok": false, "error": error }),
    };

    write_response(response, output_len)
}

fn write_response(response: Value, output_len: *mut usize) -> *mut u8 {
    let mut output = serde_json::to_vec(&response)
        .unwrap_or_else(|_| br#"{"ok":false,"error":"serialize failed"}"#.to_vec());
    let len = output.len();
    unsafe {
        *output_len = len;
    }
    let ptr = output.as_mut_ptr();
    std::mem::forget(output);
    ptr
}

#[no_mangle]
pub extern "C" fn otools_plugin_free(ptr: *mut u8, len: usize) {
    if ptr.is_null() || len == 0 {
        return;
    }

    unsafe {
        let _ = Vec::from_raw_parts(ptr, len, len);
    }
}
