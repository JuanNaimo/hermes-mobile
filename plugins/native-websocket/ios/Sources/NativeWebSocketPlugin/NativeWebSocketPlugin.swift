import Foundation
import Capacitor

/// WebSocket opened by `URLSessionWebSocketTask`: no CORS and no Origin
/// header (the Hermes dashboard rejects the WebView's origin). Mirrors the
/// Android plugin: `connect` / `send` / `close`, events carry the socket `id`.
@objc(NativeWebSocketPlugin)
public class NativeWebSocketPlugin: CAPPlugin, CAPBridgedPlugin, URLSessionWebSocketDelegate {
    public let identifier = "NativeWebSocketPlugin"
    public let jsName = "NativeWebSocket"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "connect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "send", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "close", returnType: CAPPluginReturnPromise)
    ]

    private let lock = NSLock()
    private var tasks: [String: URLSessionWebSocketTask] = [:]
    private var opened: Set<String> = []
    private var counter = 0
    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 15
        return URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }()

    @objc func connect(_ call: CAPPluginCall) {
        guard let raw = call.getString("url"), let url = URL(string: raw) else {
            call.reject("url is required")
            return
        }
        var request = URLRequest(url: url)
        if let headers = call.getObject("headers") {
            for (key, value) in headers {
                if let value = value as? String { request.setValue(value, forHTTPHeaderField: key) }
            }
        }
        let task = session.webSocketTask(with: request)
        lock.lock()
        counter += 1
        let id = "ws\(counter)"
        tasks[id] = task
        lock.unlock()
        task.taskDescription = id
        receive(task, id: id)
        task.resume()
        call.resolve(["id": id])
    }

    @objc func send(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), let data = call.getString("data") else {
            call.reject("id and data are required")
            return
        }
        guard let task = taskFor(id), isOpen(id) else {
            call.reject("Socket is not open", "NOT_OPEN")
            return
        }
        task.send(.string(data)) { error in
            if let error = error {
                call.reject(error.localizedDescription)
            } else {
                call.resolve()
            }
        }
    }

    @objc func close(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else {
            call.reject("id is required")
            return
        }
        if let task = taskFor(id) {
            let code = URLSessionWebSocketTask.CloseCode(rawValue: call.getInt("code") ?? 1000) ?? .normalClosure
            task.cancel(with: code, reason: call.getString("reason")?.data(using: .utf8))
        }
        call.resolve()
    }

    // MARK: - Socket plumbing

    private func taskFor(_ id: String) -> URLSessionWebSocketTask? {
        lock.lock()
        defer { lock.unlock() }
        return tasks[id]
    }

    private func isOpen(_ id: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return opened.contains(id)
    }

    private func receive(_ task: URLSessionWebSocketTask, id: String) {
        task.receive { [weak self] result in
            guard let self = self else { return }
            switch result {
            case .success(let message):
                switch message {
                case .string(let text):
                    self.notifyListeners("message", data: ["id": id, "data": text])
                case .data(let data):
                    self.notifyListeners("message", data: ["id": id, "data": String(decoding: data, as: UTF8.self)])
                @unknown default:
                    break
                }
                self.receive(task, id: id)
            case .failure:
                // The delegate reports the close (or the error) once the task ends.
                break
            }
        }
    }

    /// Single exit point: every socket ends with exactly one "close" event.
    private func finish(_ id: String, code: Int, reason: String) {
        lock.lock()
        let known = tasks.removeValue(forKey: id) != nil
        let wasOpen = opened.remove(id) != nil
        lock.unlock()
        guard known else { return }
        notifyListeners("close", data: ["id": id, "code": code, "reason": reason, "wasOpen": wasOpen])
    }

    public func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                           didOpenWithProtocol protocol: String?) {
        guard let id = webSocketTask.taskDescription else { return }
        lock.lock()
        opened.insert(id)
        lock.unlock()
        notifyListeners("open", data: ["id": id])
    }

    public func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                           didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        guard let id = webSocketTask.taskDescription else { return }
        let text = reason.map { String(decoding: $0, as: UTF8.self) } ?? ""
        finish(id, code: closeCode.rawValue, reason: text)
    }

    public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let id = task.taskDescription else { return }
        let status = (task.response as? HTTPURLResponse)?.statusCode ?? 0
        if let error = error {
            let message = status != 0 ? "HTTP \(status): \(error.localizedDescription)" : error.localizedDescription
            notifyListeners("error", data: ["id": id, "message": message, "status": status])
        }
        // 1006: closed abnormally (no close frame), as browsers report it.
        finish(id, code: 1006, reason: status != 0 ? "HTTP \(status)" : (error?.localizedDescription ?? ""))
    }

    deinit {
        lock.lock()
        let all = tasks.values
        lock.unlock()
        all.forEach { $0.cancel(with: .goingAway, reason: nil) }
    }
}
