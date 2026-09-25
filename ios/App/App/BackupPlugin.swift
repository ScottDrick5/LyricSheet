import Capacitor
import UIKit

/// Settings › Backup: hands the backup file to the share sheet, where "Save to Files" (or AirDrop,
/// Mail, …) puts it somewhere safe outside the app.
@objc(BackupPlugin)
public class BackupPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "BackupPlugin"
    public let jsName = "Backup"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "share", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "shareText", returnType: CAPPluginReturnPromise)
    ]

    /// Share a song's lyrics as text (Messages, Mail, AirDrop, Notes…): { text } → { completed: Bool }
    @objc func shareText(_ call: CAPPluginCall) {
        guard let text = call.getString("text"), !text.isEmpty else {
            call.reject("Nothing to share")
            return
        }
        DispatchQueue.main.async { self.present([text], call) }
    }

    /// { name: "Lyric Sheet Backup 2026-09-25.json", text: "…" } → { completed: Bool }
    @objc func share(_ call: CAPPluginCall) {
        guard let text = call.getString("text") else {
            call.reject("Nothing to save")
            return
        }
        let name = (call.getString("name") ?? "Lyric Sheet Backup.json")
            .replacingOccurrences(of: "/", with: "-")
            .replacingOccurrences(of: ":", with: "-")
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("backup", isDirectory: true)
        let url = folder.appendingPathComponent(name)
        do {
            try? FileManager.default.removeItem(at: folder)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try text.write(to: url, atomically: true, encoding: .utf8)
        } catch {
            call.reject("Couldn't create the backup file: \(error.localizedDescription)")
            return
        }
        DispatchQueue.main.async { self.present([url], call) }
    }

    private func present(_ items: [Any], _ call: CAPPluginCall) {
        guard let presenter = self.bridge?.viewController else {
            call.reject("Couldn't show the share sheet")
            return
        }
        let sheet = UIActivityViewController(activityItems: items, applicationActivities: nil)
        sheet.completionWithItemsHandler = { _, completed, _, error in
            if let error = error {
                call.reject(error.localizedDescription)
            } else {
                call.resolve(["completed": completed])
            }
        }
        // iPad shows the share sheet as a popover, which needs somewhere to point
        if let pop = sheet.popoverPresentationController {
            pop.sourceView = presenter.view
            pop.sourceRect = CGRect(x: presenter.view.bounds.midX, y: presenter.view.bounds.midY, width: 0, height: 0)
            pop.permittedArrowDirections = []
        }
        presenter.present(sheet, animated: true)
    }
}
