import UIKit
import Capacitor

/// TSF: the app's bridge view controller. Subclasses CAPBridgeViewController
/// only to register local app plugins (not npm packages) — Capacitor removed
/// automatic registration for iOS local plugins, and the hook lives on the
/// view controller (verified in Capacitor 8.5.0 CAPBridgeViewController.swift:
/// `open func capacitorDidLoad()`), not on the AppDelegate.
class MainBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        bridge?.registerPluginInstance(TsfMediaSessionPlugin())
    }
}
