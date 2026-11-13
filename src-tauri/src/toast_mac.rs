//! macOS notifications for terminals that need the user (docs/design/sessions.md section 4.7),
//! through `UNUserNotificationCenter`. Same contract as the Windows toast: clicking one brings
//! the window forward and emits `toast://activated` with the pane id.

use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, Bool, NSObject, ProtocolObject};
use objc2::{AnyThread, define_class, msg_send};
use objc2_foundation::{
    NSBundle, NSDictionary, NSError, NSObjectProtocol, NSString, NSUUID, ns_string,
};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNMutableNotificationContent, UNNotification,
    UNNotificationPresentationOptions, UNNotificationRequest, UNNotificationResponse,
    UNNotificationSound, UNUserNotificationCenter, UNUserNotificationCenterDelegate,
};
use tauri::{AppHandle, Emitter, Manager};

use crate::app_log::stamp;

static APP: OnceLock<AppHandle> = OnceLock::new();
static WARNED_NO_BUNDLE: AtomicBool = AtomicBool::new(false);
static WARNED_DENIED: AtomicBool = AtomicBool::new(false);

/// The notification center, or None for a process with no bundle identifier (the unbundled
/// `pnpm tauri dev` binary): `currentNotificationCenter` raises an Objective-C exception there,
/// which aborts the process.
fn center() -> Option<Retained<UNUserNotificationCenter>> {
    if NSBundle::mainBundle().bundleIdentifier().is_none() {
        if !WARNED_NO_BUNDLE.swap(true, Ordering::Relaxed) {
            eprintln!(
                "{} notifications off: the process has no bundle identifier",
                stamp()
            );
        }
        return None;
    }
    Some(UNUserNotificationCenter::currentNotificationCenter())
}

fn activate(pane_id: String) {
    let Some(app) = APP.get() else { return };
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(window) = handle.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
        let _ = handle.emit("toast://activated", pane_id);
    });
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements, and Delegate does not implement Drop.
    #[unsafe(super = NSObject)]
    struct Delegate;

    // SAFETY: NSObjectProtocol has no safety requirements.
    unsafe impl NSObjectProtocol for Delegate {}

    // SAFETY: The method signatures match the protocol's.
    unsafe impl UNUserNotificationCenterDelegate for Delegate {
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present(
            &self,
            _center: &UNUserNotificationCenter,
            _notification: &UNNotification,
            handler: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
        ) {
            handler.call((UNNotificationPresentationOptions::Banner
                | UNNotificationPresentationOptions::List
                | UNNotificationPresentationOptions::Sound,));
        }

        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive(
            &self,
            _center: &UNUserNotificationCenter,
            response: &UNNotificationResponse,
            handler: &block2::DynBlock<dyn Fn()>,
        ) {
            let info = response.notification().request().content().userInfo();
            let key: &AnyObject = ns_string!("paneId");
            let pane_id = info
                .objectForKey(key)
                .and_then(|value| value.downcast::<NSString>().ok())
                .map(|value| value.to_string());
            if let Some(pane_id) = pane_id {
                activate(pane_id);
            }
            handler.call(());
        }
    }
);

impl Delegate {
    fn new() -> Retained<Self> {
        let this = Self::alloc().set_ivars(());
        unsafe { msg_send![super(this), init] }
    }
}

/// Installs the delegate that routes clicks back to their pane. Called once at startup.
pub fn install(app: &AppHandle) {
    let _ = APP.set(app.clone());
    let Some(center) = center() else { return };
    let delegate = Delegate::new();
    center.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
    // The center holds its delegate weakly, so it has to live for the rest of the process.
    std::mem::forget(delegate);
}

fn post(center: &UNUserNotificationCenter, title: &str, body: &str, pane_id: &str) {
    let content = UNMutableNotificationContent::new();
    content.setTitle(&NSString::from_str(title));
    content.setBody(&NSString::from_str(body));
    content.setSound(Some(&UNNotificationSound::defaultSound()));
    let pane = NSString::from_str(pane_id);
    content.setThreadIdentifier(&pane);
    let info = NSDictionary::from_slices(&[ns_string!("paneId")], &[&*pane]);
    // SAFETY: userInfo must hold property-list types; NSString keys and values are.
    unsafe { content.setUserInfo(info.cast_unchecked::<AnyObject, AnyObject>()) };
    let id = NSUUID::UUID().UUIDString();
    let request = UNNotificationRequest::requestWithIdentifier_content_trigger(&id, &content, None);
    let done = RcBlock::new(|err: *mut NSError| {
        // SAFETY: the center passes either nil or a valid NSError.
        if let Some(err) = unsafe { err.as_ref() } {
            eprintln!(
                "{} notification not shown: {}",
                stamp(),
                err.localizedDescription()
            );
        }
    });
    center.addNotificationRequest_withCompletionHandler(&request, Some(&done));
}

/// Posts a notification for a pane. Returns at once; the post happens in the authorization
/// callback.
pub fn show(title: &str, body: &str, pane_id: &str) {
    let Some(center) = center() else { return };
    let (title, body, pane_id) = (title.to_string(), body.to_string(), pane_id.to_string());
    let target = center.clone();
    // Authorization is asked for on the first notification rather than at launch, so a user who
    // never sees one is never prompted. Asking again after the first answer returns that answer
    // without a prompt, and posting from the callback keeps the first notification.
    let done = RcBlock::new(move |granted: Bool, err: *mut NSError| {
        if granted.as_bool() {
            post(&target, &title, &body, &pane_id);
            return;
        }
        if !WARNED_DENIED.swap(true, Ordering::Relaxed) {
            // SAFETY: the center passes either nil or a valid NSError.
            let reason = unsafe { err.as_ref() }
                .map(|e| e.localizedDescription().to_string())
                .unwrap_or_else(|| "denied".to_string());
            eprintln!("{} notifications not authorized: {reason}", stamp());
        }
    });
    center.requestAuthorizationWithOptions_completionHandler(
        UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
        &done,
    );
}
