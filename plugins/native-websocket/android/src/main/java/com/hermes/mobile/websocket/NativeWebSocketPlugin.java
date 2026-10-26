package com.hermes.mobile.websocket;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;

/** Capacitor bridge over {@link SocketHub}; events carry the socket `id`. */
@CapacitorPlugin(name = "NativeWebSocket")
public class NativeWebSocketPlugin extends Plugin implements SocketHub.Listener {

    private SocketHub hub;

    @Override
    public void load() {
        hub = new SocketHub(this);
    }

    @PluginMethod
    public void connect(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("url is required");
            return;
        }
        Map<String, String> headers = new HashMap<>();
        JSObject raw = call.getObject("headers", new JSObject());
        if (raw != null) {
            Iterator<String> keys = raw.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                String value = raw.getString(key);
                if (value != null) headers.put(key, value);
            }
        }
        try {
            JSObject result = new JSObject();
            result.put("id", hub.connect(url, headers));
            call.resolve(result);
        } catch (IllegalArgumentException e) {
            call.reject("Invalid WebSocket URL: " + url, e);
        }
    }

    @PluginMethod
    public void send(PluginCall call) {
        String id = call.getString("id");
        String data = call.getString("data");
        if (id == null || data == null) {
            call.reject("id and data are required");
            return;
        }
        if (!hub.send(id, data)) {
            call.reject("Socket is not open", "NOT_OPEN");
            return;
        }
        call.resolve();
    }

    @PluginMethod
    public void close(PluginCall call) {
        String id = call.getString("id");
        if (id == null) {
            call.reject("id is required");
            return;
        }
        hub.close(id, call.getInt("code", 1000), call.getString("reason", ""));
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        if (hub != null) hub.closeAll();
    }

    // -- SocketHub.Listener (OkHttp threads; notifyListeners is thread-safe) --

    @Override
    public void onOpen(String id) {
        JSObject data = new JSObject();
        data.put("id", id);
        notifyListeners("open", data);
    }

    @Override
    public void onMessage(String id, String text) {
        JSObject data = new JSObject();
        data.put("id", id);
        data.put("data", text);
        notifyListeners("message", data);
    }

    @Override
    public void onClose(String id, int code, String reason, boolean wasOpen) {
        JSObject data = new JSObject();
        data.put("id", id);
        data.put("code", code);
        data.put("reason", reason);
        data.put("wasOpen", wasOpen);
        notifyListeners("close", data);
    }

    @Override
    public void onError(String id, String message, int httpStatus) {
        JSObject data = new JSObject();
        data.put("id", id);
        data.put("message", message);
        data.put("status", httpStatus);
        notifyListeners("error", data);
    }
}
