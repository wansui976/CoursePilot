import BackgroundTasks
import Foundation
import Network
import UIKit

/// Rust 侧 keep_alive.rs 传过来的状态。progress 在 0...1，不知道时是 -1。
struct KeepAliveArgs: Decodable {
  let active: Bool
  let title: String
  let detail: String
  let progress: Double
}

/// 处理视频、下载模型这些长任务期间不让系统把 App 挂起。
///
/// - 关掉自动锁屏：放着等它跑完，屏幕不会自己暗下去把任务冻住。
/// - iOS 26 起申请 BGContinuedProcessingTask：用户切走或锁屏后接着跑，锁屏和灵动岛上有进度，
///   用户也可以在那里停掉。申请只能在前台提交，所以任务开始时就提交，回到前台时补交。
/// - 更早的系统只有 beginBackgroundTask，切走后大约 30 秒的宽限。
///
/// 所有状态只在主线程上动。
final class KeepAliveController {
  static let shared = KeepAliveController()

  private var state = KeepAliveArgs(active: false, title: "", detail: "", progress: -1)
  private var legacyTask: UIBackgroundTaskIdentifier = .invalid
  /// iOS 26 的 BGContinuedProcessingTask；存成 AnyObject 免得整个类都要标 @available。
  private var continuedTask: AnyObject?
  private var continuedSubmitted = false
  private var continuedRegistered = false
  private var observer: NSObjectProtocol?

  private var taskIdentifier: String {
    "\(Bundle.main.bundleIdentifier ?? "dev.courseai.app").processing"
  }

  private init() {
    observer = NotificationCenter.default.addObserver(
      forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main
    ) { [weak self] _ in
      // 后台宽限用完、或者系统收回了后台任务，回到前台再申请一次。
      guard let self, self.state.active else { return }
      self.apply()
    }
  }

  func update(_ next: KeepAliveArgs) {
    state = next
    apply()
  }

  private func apply() {
    UIApplication.shared.isIdleTimerDisabled = state.active
    if state.active {
      beginLegacy()
      continuedStart()
    } else {
      continuedFinish()
      endLegacy()
    }
  }

  private func beginLegacy() {
    guard legacyTask == .invalid else { return }
    legacyTask = UIApplication.shared.beginBackgroundTask(withName: "CoursePilot long task") {
      [weak self] in
      self?.endLegacy()
    }
  }

  private func endLegacy() {
    guard legacyTask != .invalid else { return }
    UIApplication.shared.endBackgroundTask(legacyTask)
    legacyTask = .invalid
  }

  // BGContinuedProcessingTask 是 iOS 26 SDK（Xcode 26）才有的类型。旧 Xcode 编的包里没有这部分，
  // 只剩关自动锁屏和 30 秒宽限——这样旧工具链也编得过，不至于整个构建失败。
  private func continuedStart() {
    #if compiler(>=6.2)
      if #available(iOS 26.0, *) {
        startOrUpdateContinued()
      }
    #endif
  }

  private func continuedFinish() {
    #if compiler(>=6.2)
      if #available(iOS 26.0, *) {
        finishContinued()
      }
    #endif
  }

  #if compiler(>=6.2)
  @available(iOS 26.0, *)
  private func startOrUpdateContinued() {
    if let task = continuedTask as? BGContinuedProcessingTask {
      report(to: task)
      return
    }
    guard !continuedSubmitted, UIApplication.shared.applicationState == .active else { return }
    if !continuedRegistered {
      continuedRegistered = BGTaskScheduler.shared.register(
        forTaskWithIdentifier: taskIdentifier, using: .main
      ) { [weak self] task in
        guard let self, let task = task as? BGContinuedProcessingTask else {
          task.setTaskCompleted(success: true)
          return
        }
        self.attach(task)
      }
      guard continuedRegistered else {
        NSLog("keep-alive: register %@ failed", taskIdentifier)
        return
      }
    }
    let request = BGContinuedProcessingTaskRequest(
      identifier: taskIdentifier, title: state.title, subtitle: subtitle)
    // 现在跑不了就算了（还有自动锁屏关着、以及 30 秒宽限），不排到以后——过后再跑没意义。
    request.strategy = .fail
    do {
      try BGTaskScheduler.shared.submit(request)
      continuedSubmitted = true
    } catch {
      NSLog("keep-alive: submit failed: %@", error.localizedDescription)
    }
  }

  @available(iOS 26.0, *)
  private func attach(_ task: BGContinuedProcessingTask) {
    guard state.active else {
      continuedSubmitted = false
      task.setTaskCompleted(success: true)
      return
    }
    continuedTask = task
    task.progress.totalUnitCount = 1000
    task.expirationHandler = { [weak self] in
      // 系统收回了（或者用户在锁屏上点了停止）：这里只能放手，App 切走后任务会被冻住，
      // 回到前台接着跑。
      DispatchQueue.main.async {
        guard let self, self.continuedTask === task else { return }
        self.continuedTask = nil
        self.continuedSubmitted = false
        task.setTaskCompleted(success: false)
      }
    }
    report(to: task)
  }

  @available(iOS 26.0, *)
  private func report(to task: BGContinuedProcessingTask) {
    task.updateTitle(state.title, subtitle: subtitle)
    if state.progress >= 0 {
      task.progress.completedUnitCount = Int64((state.progress * 1000).rounded())
    }
  }

  @available(iOS 26.0, *)
  private func finishContinued() {
    if let task = continuedTask as? BGContinuedProcessingTask {
      task.progress.completedUnitCount = task.progress.totalUnitCount
      task.setTaskCompleted(success: true)
    }
    continuedTask = nil
    continuedSubmitted = false
  }
  #endif

  private var subtitle: String {
    state.detail.isEmpty ? "CoursePilot" : state.detail
  }
}

/// 现在的网络是不是按流量计费（手机数据、个人热点、低数据模式）。
final class NetworkStatus {
  static let shared = NetworkStatus()

  private let monitor = NWPathMonitor()
  private let lock = NSLock()
  private var path: NWPath?

  private init() {
    monitor.pathUpdateHandler = { [weak self] path in
      guard let self else { return }
      self.lock.lock()
      self.path = path
      self.lock.unlock()
    }
    monitor.start(queue: DispatchQueue(label: "dev.courseai.network-status"))
  }

  /// 第一次调用时监视器刚起来，等它报出当前网络（通常几毫秒）。
  var metered: Bool {
    for _ in 0..<20 {
      lock.lock()
      let current = path
      lock.unlock()
      if let current {
        return current.isExpensive || current.isConstrained
      }
      Thread.sleep(forTimeInterval: 0.025)
    }
    return monitor.currentPath.isExpensive || monitor.currentPath.isConstrained
  }
}
