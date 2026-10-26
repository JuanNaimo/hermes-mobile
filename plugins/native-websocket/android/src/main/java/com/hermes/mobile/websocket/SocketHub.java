package com.hermes.mobile.websocket;

import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;

/**
 * The sockets themselves, with no Android or Capacitor types so it runs (and
 * is tested) on a plain JVM. OkHttp sends no Origin header, which is the
 * point: the Hermes dashboard rejects a WebView's `http://localhost` origin.
 */
public class SocketHub {

    public interface Listener {
        void onOpen(String id);

        void onMessage(String id, String text);

        /** Always the last event for a socket, after an error too. */
        void onClose(String id, int code, String reason, boolean wasOpen);

        void onError(String id, String message, int httpStatus);
    }

    private final OkHttpClient client;
    private final Listener listener;
    private final Map<String, WebSocket> sockets = new ConcurrentHashMap<>();
    /** Registered before the connect starts, so a failure that beats `sockets.put` still reports. */
    private final Set<String> live = ConcurrentHashMap.newKeySet();
    private final Set<String> opened = ConcurrentHashMap.newKeySet();
    private final AtomicInteger counter = new AtomicInteger();

    public SocketHub(Listener listener) {
        this.listener = listener;
        this.client = new OkHttpClient.Builder()
            // Protocol-level pings keep NAT/Wi-Fi mappings alive between turns.
            .pingInterval(20, TimeUnit.SECONDS)
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .build();
    }

    public String connect(String url, Map<String, String> headers) {
        final String id = "ws" + counter.incrementAndGet();
        Request.Builder request = new Request.Builder().url(url);
        if (headers != null) {
            for (Map.Entry<String, String> h : headers.entrySet()) {
                request.header(h.getKey(), h.getValue());
            }
        }
        live.add(id);
        WebSocket socket = client.newWebSocket(request.build(), new WebSocketListener() {
            @Override
            public void onOpen(WebSocket webSocket, Response response) {
                opened.add(id);
                listener.onOpen(id);
            }

            @Override
            public void onMessage(WebSocket webSocket, String text) {
                listener.onMessage(id, text);
            }

            @Override
            public void onMessage(WebSocket webSocket, ByteString bytes) {
                listener.onMessage(id, bytes.utf8());
            }

            @Override
            public void onClosing(WebSocket webSocket, int code, String reason) {
                // Server-initiated close: answer it so onClosed follows.
                webSocket.close(code == 1005 ? 1000 : code, null);
            }

            @Override
            public void onClosed(WebSocket webSocket, int code, String reason) {
                finish(id, code, reason);
            }

            @Override
            public void onFailure(WebSocket webSocket, Throwable t, Response response) {
                int status = response != null ? response.code() : 0;
                String message = t.getMessage() != null ? t.getMessage() : t.getClass().getSimpleName();
                if (status != 0) message = "HTTP " + status + ": " + message;
                listener.onError(id, message, status);
                // 1006: closed abnormally (no close frame), as browsers report it.
                finish(id, 1006, status != 0 ? "HTTP " + status : message);
            }
        });
        // Skip if it already failed and finished in the meantime.
        if (live.contains(id)) sockets.put(id, socket);
        return id;
    }

    private void finish(String id, int code, String reason) {
        if (!live.remove(id)) return;
        sockets.remove(id);
        boolean wasOpen = opened.remove(id);
        listener.onClose(id, code, reason == null ? "" : reason, wasOpen);
    }

    public boolean send(String id, String text) {
        WebSocket socket = sockets.get(id);
        return socket != null && socket.send(text);
    }

    public void close(String id, int code, String reason) {
        WebSocket socket = sockets.get(id);
        if (socket != null && !socket.close(code, reason)) {
            // Already closing or failed: make sure JS still hears about it.
            socket.cancel();
            finish(id, code, reason);
        }
    }

    public void closeAll() {
        for (Map.Entry<String, WebSocket> entry : sockets.entrySet()) {
            entry.getValue().cancel();
            finish(entry.getKey(), 1001, "app closed");
        }
    }
}
