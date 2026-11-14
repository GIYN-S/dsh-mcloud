/**
 * dsh-mcloud — Client half.
 *
 * 会话窗口顶部 View 标签条里的一个新标签「移动云盘」，选中后是一整条面板：
 *   1. 授权：粘贴 yun.139.com 的 Authorization（Basic 后面的部分）；ud_id 可选
 *   2. 状态：账号、授权有效期、容量进度条、剩余空间
 *   3. 文件：面包屑浏览、新建文件夹、重命名、删除、下载直链
 *
 * 只走 Host 的 /api/dsh-mcloud/* 路由；自己既不去读 Cookie，也不去碰磁盘。
 * Host 契约见插件 README：status / auth / auth/clear / list / mkdir / mkdir-path / rename /
 * move / remove / link / upload-body，所有 POST 都带 x-dsh-mcloud: 1。
 *
 * 之后又长出来三块（一样只走 Host）：
 *   4. 右键菜单：行上右键 → 打开 / 下载 / 重命名 / 删除；列表空白处右键 → 新建 / 刷新 / 上传
 *   5. 下载：下载目录（localStorage 持久化，默认用 status.defaultDownloadDir）、
 *      「下载到本地」（POST /download）、「下载整个文件夹」（POST /download-folder）
 *   6. 上传（POST /upload）与传输面板（GET /transfers 轮询 + POST /transfer/cancel）——
 *      Host 的这三个 POST 立刻回 jobId，成败要等任务自己变成 state:'error'，别把它吞掉。
 *   7. 选文件用**浏览器自己的** <input type="file"> —— 不再让 Host spawn 系统对话框
 *      （那条路在 DSH 宿主里起不来，还抢焦点 / 卡 z-order）：
 *      「上传文件」→ multiple 多选，选完逐个 XMLHttpRequest POST /upload-body 上传；
 *      「上传文件夹」→ webkitdirectory 选择，先按 webkitRelativePath 逐层
 *      POST /mkdir-path 把远端目录建出来，再把每个文件塞进它自己那一层；
 *      拖拽区也复用同一条 /upload-body（原始字节），这样浏览器才拿得到
 *      「浏览器→Host」这一段的上行进度（fetch 拿不到）。
 *      取消文件对话框时浏览器不发任何事件，靠 window 的 focus 兜底恢复按钮。
 */
if (typeof window !== 'undefined' && window.__ModuleLoader__ && typeof window.__ModuleLoader__.load === 'function') {
  window.__ModuleLoader__.load({
    id: 'dsh-mcloud',
    factory: function (require) {
      var React = require('react')
      var h = React.createElement
      /** 有 useLayoutEffect 就用它量菜单尺寸（免得菜单先闪一下再翻边）。 */
      var useLayout = typeof React.useLayoutEffect === 'function' ? React.useLayoutEffect : React.useEffect

      var NS = 'dsh-mcloud'
      var BASE = '/api/dsh-mcloud'

      // ---------------------------------------------------------------- 日志
      function logWarn(scope, failure) {
        if (typeof console === 'undefined' || typeof console.warn !== 'function') return
        console.warn('[dsh-mcloud] ' + scope, failure)
      }
      function logError(scope, failure) {
        if (typeof console === 'undefined' || typeof console.error !== 'function') return
        console.error('[dsh-mcloud] ' + scope, failure)
      }

      // ---------------------------------------------------------------- 文案
      var ZH = {
        nav: '移动云盘',
        title: '移动云盘',
        subtitle: '中国移动云盘（139）的文件浏览与授权',
        refresh: '刷新',
        refreshFailed: '读取状态失败：{detail}',
        account: '账号',
        expires: '授权有效期',
        expiresShort: '有效期：',
        expired: '已过期',
        quota: '容量',
        used: '已用',
        free: '剩余空间',
        total: '总容量',
        unauthorized: '还没有授权',
        notAuthorized: '还没有登录，请先登录。',
        authorization: '授权',
        quotaUnavailable: '容量：暂时不可用',
        save: '保存并验证',
        saving: '验证中…',
        authOk: '授权成功',
        // 登录页：账号密码 / 手动授权 两个标签
        loginTitle: '登录移动云盘',
        tabLogin: '账号密码登录',
        tabScan: '扫码登录',
        scanIntro: '点击下面的按钮，会弹出一个浏览器窗口，用手机扫码登录即可。',
        scanStart: '开始扫码登录',
        scanRetry: '重新扫码',
        scanLaunching: '正在启动浏览器…',
        scanWaiting: '请在弹出的浏览器里扫码登录',
        scanDone: '登录成功',
        scanCancelled: '已取消',
        scanFailed: '扫码登录失败',
        scanDoneHint: '登录成功！凭据已保存，之后会自动续期，不需要反复扫码。',
        scanBrowserHint: '浏览器窗口可能开在后台，找不到就看任务栏。',
        scanSecurityNote: '扫码登录不经过密码，插件只读取登录后的凭据；凭据加密保存在本机。',
        loginAccount: '手机号 / 邮箱',
        loginAccountPlaceholder: '输入手机号或邮箱',
        loginPassword: '密码',
        loginPasswordPlaceholder: '输入密码',
        rememberPassword: '记住密码',
        rememberPasswordHint: '勾选后密码会加密保存在本机；不勾选则只在登录时使用一次',
        loginSubmit: '登录',
        loginBusy: '登录中…',
        loginOk: '登录成功',
        loginSavedHint: '已保存密码，可直接登录',
        showPassword: '显示密码',
        hidePassword: '隐藏密码',
        loginSecurityNote: '仅用于换取访问令牌；密码不会发送到除运营商外的任何地方',
        loginEmpty: '请输入手机号/邮箱和密码',
        reauthorize: '重新授权',
        reauthorizeShort: '授权',
        clearAuth: '清除授权',
        clearAuthShort: '退出',
        clearConfirm: '退出登录并清除本机保存的凭据？之后需要重新登录。',
        root: '/',
        up: '返回上级',
        newFolder: '新建文件夹',
        folderName: '文件夹名称',
        create: '创建',
        cancel: '取消',
        rename: '重命名',
        renamePrompt: '输入新名称',
        remove: '删除',
        removeConfirm: '确定删除「{name}」？此操作不可恢复。',
        downloadLink: '下载直链',
        more: '加载更多',
        loading: '加载中…',
        empty: '这个文件夹是空的',
        listFailed: '读取目录失败：{detail}',
        actFailed: '操作失败：{detail}',
        openFailed: '打开直链失败：{detail}',
        host: '主机',
        credentialFileName: '凭证文件',
        footerHint: '所有请求都经由 Host 的 /api/dsh-mcloud 转发。',
        error: '出错了',
        // 右键菜单
        menuOpen: '打开',
        menuDownloadFolder: '下载整个文件夹',
        menuDownloadLocal: '下载到本地',
        menuDownloadLink: '打开下载直链',
        menuRename: '重命名',
        menuRemove: '删除',
        menuNewFolder: '新建文件夹',
        menuRefresh: '刷新',
        menuUpload: '上传',
        menuUploadFile: '上传文件',
        menuUploadFolder: '上传文件夹',
        menuDragUpload: '拖动上传',
        menuMove: '转移到…',
        menuCopyPath: '复制路径',
        pathCopied: '已复制：{path}',
        copyFailed: '复制失败，路径是：{path}',
        moveTitle: '转移文件',
        moveSource: '把「{name}」转移到：',
        moveHere: '转移到「{name}」',
        moveNoFolders: '这个文件夹里没有子文件夹',
        moveSelf: '不能转移到自己所在的位置',
        moveInside: '不能转移到自己里面',
        menuTypePath: '直接填路径',
        // 下载目录 / 上传
        downloadDir: '下载目录',
        downloadDirShort: '下载到',
        downloadDirHint: '「下载到本地」的文件会存到这个目录；路径是运行 DSH 那台机器上的路径。',
        downloadDirSaved: '下载目录已保存',
        chooseDir: '选择目录',
        resetDefault: '恢复默认',
        save: '保存',

        // ===== 0.3.0 资源管理器 =====
        folders: '文件夹',
        treeResizeHint: '拖动调整宽度（双击恢复默认）',
        expand: '展开',
        collapse: '收起',
        toggleTree: '显示/隐藏文件夹树',
        colName: '名称',
        colSize: '大小',
        colModified: '修改时间',
        colResizeHint: '拖动调整列宽（双击恢复默认）',
        search: '搜索',
        searchPlaceholder: '搜索文件…',
        searchClear: '清空搜索',
        searching: '正在搜索…',
        searchIn: '在 {path} 及其子目录中搜索',
        searchNoResult: '没有找到匹配的文件',
        searchCount: '找到 {count} 项',
        searchTruncated: '找到 {count} 项（结果过多，已截断）',
        searchExit: '退出搜索',
        feedMoreHint: '继续向下滚动加载更多',

        // 历史传输记录
        history: '传输记录',
        historyShort: '记录',
        historyTitle: '传输记录',
        historyClear: '清空记录',
        historyClearConfirm: '清空全部传输记录？\n\n只删除记录列表，网盘和本地文件都不会受影响。正在传输的任务会保留。',
        historyCleared: '已清空 {count} 条记录',
        historyActive: '进行中',
        historyDone: '已完成',
        historyFailed: '失败',
        historyCancelled: '已取消',
        historyEmpty: '还没有传输记录。上传或下载一个文件就会出现在这里。',
        jobDone: '已完成',
        jobFailed: '失败',
        jobCancelled: '已取消',
        jobQueued: '排队中',
        jobScanning: '扫描目录',
        jobRunning: '传输中',
        close: '关闭',
        transfersMore: '还有 {count} 项',
        transfersDone: '已完成 {count} 个传输任务',
        transfersFailed: '{count} 个任务失败',
        upload: '上传',
        uploadPath: '本机文件绝对路径，例如 D:\\tmp\\a.zip',
        uploadPathHint: '这个路径指向运行 DSH 的那台机器，不是浏览器所在的机器。',
        uploadToCurrent: '上传到当前目录',
        // 账号显示名（本机自定义，移动云盘没有昵称接口）
        displayName: '显示名',
        displayNamePlaceholder: '留空 = 显示脱敏手机号',
        displayNameHint: '移动云盘没有查昵称的接口，这里填什么就显示什么（只存在本机浏览器里）。',
        displayNameSave: '保存',
        displayNameClear: '清除',
        // 选择本机文件 / 拖拽上传
        pickFile: '选择文件…',
        pickFolder: '选择文件夹…',
        pickWaiting: '等待选择…',
        pickCancelled: '已取消选择',
        pickHint: '会弹出系统文件对话框；上传直接从磁盘读取，大文件不会先复制一份。',
        uploadFolderStarted: '正在上传文件夹：{name}',
        uploadFolderDone: '文件夹上传完成：{name}（{count} 个文件）',
        uploadFolderFailed: '文件夹上传失败：{detail}',
        noFilesSelected: '没有选择任何文件',
        dropZone: '把文件拖到这里上传',
        dropActive: '松开鼠标即上传',
        dropHint: '拖进来的文件会传到当前打开的这个目录。',
        dropFolderHint: '文件夹请点上面的「选择文件夹…」',
        orTypePath: '或直接填路径',
        dragUploadOpen: '拖动上传…',
        uploadPanelTitle: '上传到「{name}」',
        uploadPanelHere: '上传到当前目录',
        uploadPanelHint: '把文件拖进下面的区域就开始上传；文件夹请用「选择文件夹…」',
        close: '关闭',
        urlUploading: '上传中 {name} · {percent}%',
        urlUploadDone: '已上传 {name}',
        urlUploadFailed: '上传失败：{detail}',
        // 传输
        transfers: '传输',
        transferCancel: '取消',
        transferCanceled: '已请求取消',
        transferRunning: '进行中',
        transferDone: '已完成',
        transferFailed: '失败',
        progressUnknown: '进行中',
        noTransfers: '还没有传输任务。',
        filesUnit: '个文件',
        confirmDownloadFolder: '「{name}」里的每个文件都会单独下载一遍，文件多或很大时会比较慢。确定要下载整个文件夹吗？',
        downloadStarted: '已开始下载：{name}',
        uploadStarted: '已开始上传：{name}',
        phasePrepare: '准备',
        phaseHash: '校验哈希',
        phaseCreate: '创建任务',
        phaseUpload: '上传中',
        phaseScan: '扫描目录',
        phaseDownload: '下载中',
        phaseComplete: '已完成',
      }
      var EN = {
        nav: 'Mobile Cloud',
        title: 'China Mobile Cloud Drive',
        subtitle: 'Browse and authorize China Mobile Cloud Drive (yun.139.com)',
        refresh: 'Refresh',
        refreshFailed: 'Could not read status: {detail}',
        account: 'Account',
        expires: 'Authorized until',
        expiresShort: 'Expires: ',
        expired: 'Expired',
        quota: 'Storage',
        used: 'Used',
        free: 'Free space',
        total: 'Total',
        unauthorized: 'Not authorized yet',
        notAuthorized: 'Not authorized yet — paste the Authorization value above.',
        authorization: 'Authorization',
        quotaUnavailable: 'Storage: temporarily unavailable',
        save: 'Save and verify',
        saving: 'Verifying…',
        authOk: 'Authorization saved',
        // Sign-in page: password / manual authorization tabs
        loginTitle: 'Sign in to Mobile Cloud',
        tabLogin: 'Password sign-in',
        tabScan: 'Scan to sign in',
        scanIntro: 'Click the button below. A browser window opens — scan the QR code with your phone to sign in.',
        scanStart: 'Start scan login',
        scanRetry: 'Scan again',
        scanLaunching: 'Launching browser…',
        scanWaiting: 'Scan the QR code in the browser window',
        scanDone: 'Signed in',
        scanCancelled: 'Cancelled',
        scanFailed: 'Scan login failed',
        scanDoneHint: 'Signed in. The credential is saved and will refresh automatically — no need to scan again.',
        scanBrowserHint: 'The browser window may open in the background; check your taskbar.',
        scanSecurityNote: 'Scan login never involves your password. The plugin only reads the credential after you sign in, and stores it encrypted locally.',
        loginAccount: 'Phone / email',
        loginAccountPlaceholder: 'Phone or email',
        loginPassword: 'Password',
        loginPasswordPlaceholder: 'Password',
        rememberPassword: 'Remember password',
        rememberPasswordHint: 'If checked the password is encrypted and stored locally; otherwise it is used once and discarded',
        loginSubmit: 'Sign in',
        loginBusy: 'Signing in…',
        loginOk: 'Signed in',
        loginSavedHint: 'Password saved, you can sign in directly',
        showPassword: 'Show password',
        hidePassword: 'Hide password',
        loginSecurityNote: 'Used only to obtain an access token; the password is never sent anywhere but the carrier',
        loginEmpty: 'Enter your phone/email and password',
        reauthorize: 'Re-authorize',
        reauthorizeShort: 'Auth',
        clearAuth: 'Clear authorization',
        clearAuthShort: 'Sign out',
        clearConfirm: 'Clear the stored Mobile Cloud authorization? You will need to paste the Authorization value again.',
        root: '/',
        up: 'Up one level',
        newFolder: 'New folder',
        folderName: 'Folder name',
        create: 'Create',
        cancel: 'Cancel',
        rename: 'Rename',
        renamePrompt: 'Enter a new name',
        remove: 'Delete',
        removeConfirm: 'Delete "{name}"? This cannot be undone.',
        downloadLink: 'Get link',
        more: 'Load more',
        loading: 'Loading…',
        empty: 'This folder is empty',
        listFailed: 'Could not read this folder: {detail}',
        actFailed: 'Action failed: {detail}',
        openFailed: 'Could not open the link: {detail}',
        host: 'Host',
        credentialFileName: 'Credential file',
        footerHint: 'Every request goes through the host route /api/dsh-mcloud.',
        error: 'Something went wrong',
        // Context menu
        menuOpen: 'Open',
        menuDownloadFolder: 'Download whole folder',
        menuDownloadLocal: 'Download to this machine',
        menuDownloadLink: 'Open download link',
        menuRename: 'Rename',
        menuRemove: 'Delete',
        menuNewFolder: 'New folder',
        menuRefresh: 'Refresh',
        menuUpload: 'Upload',
        menuUploadFile: 'Upload files',
        menuUploadFolder: 'Upload a folder',
        menuDragUpload: 'Drag and drop upload',
        menuMove: 'Move to…',
        menuCopyPath: 'Copy path',
        pathCopied: 'Copied: {path}',
        copyFailed: 'Copy failed, the path is: {path}',
        moveTitle: 'Move',
        moveSource: 'Move "{name}" to:',
        moveHere: 'Move to "{name}"',
        moveNoFolders: 'No subfolders here',
        moveSelf: 'Cannot move to the same location',
        moveInside: 'Cannot move into itself',
        menuTypePath: 'Type a path instead',
        // Download dir / upload
        downloadDir: 'Download folder',
        downloadDirShort: 'Save to',
        downloadDirHint: 'Files downloaded to this machine land in this folder; the path is on the machine running DSH.',
        downloadDirSaved: 'Download folder saved',
        chooseDir: 'Choose folder',
        resetDefault: 'Reset to default',
        save: 'Save',

        // ===== 0.3.0 explorer =====
        folders: 'Folders',
        treeResizeHint: 'Drag to resize (double-click to reset)',
        expand: 'Expand',
        collapse: 'Collapse',
        toggleTree: 'Show/hide folder tree',
        colName: 'Name',
        colSize: 'Size',
        colModified: 'Modified',
        colResizeHint: 'Drag to resize column (double-click to reset)',
        search: 'Search',
        searchPlaceholder: 'Search files…',
        searchClear: 'Clear search',
        searching: 'Searching…',
        searchIn: 'Searching in {path} and its subfolders',
        searchNoResult: 'No matching files',
        searchCount: 'Found {count}',
        searchTruncated: 'Found {count} (truncated)',
        searchExit: 'Exit search',
        feedMoreHint: 'Scroll down to load more',

        // Transfer history
        history: 'Transfers',
        historyShort: 'Log',
        historyTitle: 'Transfer history',
        historyClear: 'Clear history',
        historyClearConfirm: 'Clear all transfer records?\n\nOnly the list is removed — files on the drive and on disk are untouched. Transfers still running are kept.',
        historyCleared: 'Cleared {count} record(s)',
        historyActive: 'In progress',
        historyDone: 'Completed',
        historyFailed: 'Failed',
        historyCancelled: 'Cancelled',
        historyEmpty: 'No transfers yet. Upload or download a file and it will show up here.',
        jobDone: 'Done',
        jobFailed: 'Failed',
        jobCancelled: 'Cancelled',
        jobQueued: 'Queued',
        jobScanning: 'Scanning',
        jobRunning: 'Transferring',
        close: 'Close',
        transfersMore: '{count} more',
        transfersDone: '{count} transfer(s) completed',
        transfersFailed: '{count} transfer(s) failed',
        upload: 'Upload',
        uploadPath: 'Absolute path on this machine, e.g. D:\\tmp\\a.zip',
        uploadPathHint: 'The path is on the machine running DSH, not the machine with the browser.',
        uploadToCurrent: 'Upload to current folder',
        // Account display name (local only — the drive has no nickname API)
        displayName: 'Display name',
        displayNamePlaceholder: 'Blank = show the masked phone number',
        displayNameHint: 'The drive has no API for reading your nickname, so whatever you type here is shown as-is (it stays in this browser only).',
        displayNameSave: 'Save',
        displayNameClear: 'Clear',
        // Picking local files / drag and drop
        pickFile: 'Choose files…',
        pickFolder: 'Choose folder…',
        pickWaiting: 'Waiting for selection…',
        pickCancelled: 'Selection cancelled',
        pickHint: 'Opens the native file dialog; uploads are read straight from disk, so a large file is not copied first.',
        uploadFolderStarted: 'Uploading folder: {name}',
        uploadFolderDone: 'Folder uploaded: {name} ({count} files)',
        uploadFolderFailed: 'Folder upload failed: {detail}',
        noFilesSelected: 'No files selected',
        dropZone: 'Drop files here to upload',
        dropActive: 'Release to upload',
        dropHint: 'Anything you drop goes to the folder that is open right now.',
        dropFolderHint: 'For a folder, use “Choose folder…” above.',
        orTypePath: 'Or type a path',
        dragUploadOpen: 'Drag and drop…',
        uploadPanelTitle: 'Upload to "{name}"',
        uploadPanelHere: 'Upload to the current folder',
        uploadPanelHint: 'Drop files into the area below to start uploading; for a folder, use “Choose folder…”.',
        close: 'Close',
        urlUploading: 'Uploading {name} · {percent}%',
        urlUploadDone: 'Uploaded {name}',
        urlUploadFailed: 'Upload failed: {detail}',
        // Transfers
        transfers: 'Transfers',
        transferCancel: 'Cancel',
        transferCanceled: 'Cancellation requested',
        transferRunning: 'Running',
        transferDone: 'Done',
        transferFailed: 'Failed',
        progressUnknown: 'in progress',
        noTransfers: 'No transfers yet.',
        filesUnit: 'files',
        confirmDownloadFolder: 'Every file inside "{name}" is downloaded one by one, so a large or deep folder can be slow. Download the whole folder?',
        downloadStarted: 'Download started: {name}',
        uploadStarted: 'Upload started: {name}',
        phasePrepare: 'preparing',
        phaseHash: 'hashing',
        phaseCreate: 'creating',
        phaseUpload: 'uploading',
        phaseScan: 'scanning',
        phaseDownload: 'downloading',
        phaseComplete: 'complete',
      }

      /**
       * 字典取词。查不到就原样返回 key，方便看出哪个词条漏了。
       * 等价于 fallback `function (key) { return ZH[key] || key }`，另外支持 {name} 占位。
       */
      function translate(dict) {
        return function (key, params) {
          var template = dict[key] !== undefined ? dict[key] : key
          if (!params) return template
          return template.replace(/\{(\w+)\}/g, function (whole, name) {
            return name in params ? String(params[name]) : whole
          })
        }
      }

      // ---------------------------------------------------------------- 样式
      // 中性灰：优先用 Theme token，拿不到就退回在浅色/深色底上都能看的中性灰。
      var GREY_1 = 'var(--dsw-alias-label-primary,#1f2329)'
      var GREY_2 = 'var(--dsw-alias-label-secondary,#8a8f99)'
      var LINE = 'var(--dsw-alias-border-l2,rgba(127,127,127,.34))'
      var LAYER_1 = 'var(--dsw-alias-bg-layer-1,rgba(127,127,127,.06))'
      var LAYER_2 = 'var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12))'
      var DANGER = 'var(--dsw-alias-state-error-primary,#d9534f)'

      var CSS_TEXT = [
        '.mc-root{box-sizing:border-box;height:100%;min-height:0;overflow-y:auto;display:flex;flex-direction:column;align-items:center;padding:24px clamp(16px,3vw,40px) 40px;gap:16px;color:' + GREY_1 + '}',
        '.mc-root>*{width:100%;max-width:960px}',
        '.mc-stack{display:flex;flex-direction:column;gap:16px}',
        '.mc-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;flex-wrap:wrap}',
        '.mc-title{font-size:20px;font-weight:600;line-height:28px;margin:0}',
        '.mc-subtitle{margin:4px 0 0;font-size:12px;line-height:18px;color:' + GREY_2 + '}',
        '.mc-headActions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
        '.mc-notice{font-size:12px;line-height:18px;color:' + GREY_2 + '}',
        '.mc-btn{appearance:none;font:inherit;font-size:13px;line-height:18px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;border:0.5px solid ' + LINE + ';border-radius:8px;padding:6px 12px;background:transparent;color:' + GREY_1 + ';transition:background-color .14s ease,border-color .14s ease}',
        '.mc-btn:hover:not(:disabled){background:' + LAYER_2 + '}',
        '.mc-btn:disabled{opacity:.45;cursor:default}',
        '.mc-btnPrimary{border-color:transparent;background:' + LAYER_2 + ';font-weight:600}',
        '.mc-btnDanger{color:' + DANGER + ';border-color:' + DANGER + '}',
        '.mc-btnSmall{padding:3px 9px;font-size:12px;line-height:16px;border-radius:6px}',
        '.mc-card{border:0.5px solid ' + LINE + ';border-radius:12px;background:' + LAYER_1 + ';padding:16px 18px;display:flex;flex-direction:column;gap:12px}',
        '.mc-cardHead{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}',
        '.mc-cardTitle{font-size:14px;font-weight:600;line-height:22px;margin:0}',
        '.mc-cardActions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
        '.mc-hint{margin:0;font-size:12px;line-height:19px;color:' + GREY_2 + ';white-space:pre-wrap;word-break:break-word}',
        '.mc-field{display:flex;flex-direction:column;gap:5px}',
        '.mc-label{font-size:12px;line-height:17px;color:' + GREY_2 + '}',
        '.mc-input{box-sizing:border-box;width:100%;font:inherit;font-size:13px;line-height:18px;color:' + GREY_1 + ';background:transparent;border:0.5px solid ' + LINE + ';border-radius:8px;padding:7px 10px}',
        '.mc-input::placeholder{color:' + GREY_2 + '}',
        '.mc-inlineForm{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
        '.mc-inlineForm .mc-input{flex:1 1 220px;max-width:340px}',
        '.mc-banner{border:0.5px solid ' + LINE + ';border-radius:10px;padding:9px 12px;font-size:12px;line-height:18px;word-break:break-word;background:' + LAYER_2 + '}',
        '.mc-bannerErr{border-color:' + DANGER + ';color:' + DANGER + '}',
        '.mc-bannerOk{border-color:' + LINE + ';color:' + GREY_2 + '}',
        '.mc-kv{display:flex;align-items:baseline;gap:10px;font-size:12px;line-height:19px}',
        '.mc-kvLabel{flex:none;min-width:76px;color:' + GREY_2 + '}',
        '.mc-kvValue{min-width:0;word-break:break-all}',
        // 账号行：显示名 / 脱敏手机号 + 小铅笔
        '.mc-acctLine{display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}',
        '.mc-acctText{min-width:0;word-break:break-all}',
        '.mc-acctSub{display:block;margin-top:2px;font-size:11px;line-height:16px;color:' + GREY_2 + '}',
        '.mc-acctForm{display:flex;flex-direction:column;gap:8px;margin-top:2px}',
        '.mc-acctWarn{display:block;margin-top:2px;font-size:11px;line-height:16px;color:' + DANGER + '}',
        '.mc-barWrap{display:flex;flex-direction:column;gap:6px}',
        '.mc-barText{font-size:12px;line-height:18px;color:' + GREY_2 + ';font-variant-numeric:tabular-nums}',
        '.mc-bar{position:relative;height:8px;border-radius:999px;overflow:hidden;background:' + LAYER_2 + '}',
        '.mc-barFill{height:100%;border-radius:999px;background:' + GREY_2 + ';transition:width .2s ease}',
        '.mc-crumbs{display:inline-flex;align-items:center;gap:4px;flex-wrap:wrap;min-width:0;max-width:100%;box-sizing:border-box;padding:0;border:0;background:transparent}',
        '.mc-crumb{appearance:none;display:inline-flex;align-items:center;box-sizing:border-box;border:0.5px solid ' + LINE + ';background:' + LAYER_1 + ';font:inherit;font-size:13px;font-weight:600;line-height:20px;color:' + GREY_1 + ';cursor:pointer;padding:3px 9px;border-radius:8px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.mc-crumb:hover{background:' + LAYER_2 + '}',
        '.mc-crumbSep{font-size:13px;line-height:20px;font-weight:600;color:' + GREY_2 + ';user-select:none}',
        '.mc-rows{display:flex;flex-direction:column}',
        '.mc-row{display:flex;align-items:center;gap:10px;padding:7px 4px;border-top:0.5px solid ' + LINE + ';font-size:13px;line-height:19px}',
        '.mc-row:first-child{border-top:0}',
        '.mc-rowIcon{flex:none;width:18px;text-align:center}',
        '.mc-rowName{min-width:0;flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.mc-rowNameBtn{appearance:none;border:0;background:transparent;font:inherit;color:inherit;text-align:left;padding:0;cursor:pointer;text-decoration:underline;text-decoration-color:' + LINE + '}',
        '.mc-rowMeta{flex:none;font-size:12px;color:' + GREY_2 + ';font-variant-numeric:tabular-nums}',
        '.mc-rowSize{min-width:72px;text-align:right}',
        '.mc-rowTime{min-width:118px;text-align:right}',
        '.mc-rowActions{flex:none;display:flex;align-items:center;gap:6px}',
        '.mc-loading,.mc-empty{padding:14px 0;font-size:12px;line-height:18px;color:' + GREY_2 + ';text-align:center}',
        // 列表区域要有最小高度，「空白处右键」才点得到。
        '.mc-listArea{display:flex;flex-direction:column;min-height:104px}',
        // 浮层菜单：fixed 定在光标处，颜色在浅色/深色底下都要看得清。
        '.mc-menu{position:fixed;z-index:80;box-sizing:border-box;min-width:176px;width:auto;max-width:min(280px,90vw);padding:4px;border:0.5px solid ' + LINE + ';border-radius:10px;background:var(--dsw-alias-bg-layer-3,#ffffff);box-shadow:0 10px 28px rgba(0,0,0,.22)}',
        '.mc-root>.mc-menu{width:auto;max-width:min(280px,90vw)}',
        '.mc-menuHead{padding:5px 10px 6px;font-size:11px;line-height:16px;color:' + GREY_2 + ';overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.mc-menuItem{display:flex;box-sizing:border-box;width:100%;appearance:none;border:0;background:transparent;font:inherit;font-size:13px;line-height:18px;color:' + GREY_1 + ';text-align:left;padding:7px 10px;border-radius:7px;cursor:pointer}',
        '.mc-menuItem:hover{background:' + LAYER_2 + '}',
        '.mc-menuItem:focus-visible{background:' + LAYER_2 + ';outline:none}',
        '.mc-menuItemDanger{color:' + DANGER + '}',
        '.mc-menuSep{height:0;margin:4px 6px;border:0;border-top:0.5px solid ' + LINE + '}',
        // 传输任务
        '.mc-job{display:flex;flex-direction:column;gap:6px;padding:9px 0;border-top:0.5px solid ' + LINE + '}',
        '.mc-job:first-child{border-top:0;padding-top:2px}',
        '.mc-jobHead{display:flex;align-items:center;gap:8px}',
        '.mc-jobIcon{flex:none;width:18px;text-align:center}',
        '.mc-jobLabel{min-width:0;flex:1 1 auto;font-size:13px;line-height:19px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.mc-jobState{flex:none;font-size:12px;line-height:18px;color:' + GREY_2 + '}',
        '.mc-jobErr{font-size:12px;line-height:18px;color:' + DANGER + ';word-break:break-word}',
        '.mc-jobMeta{font-size:11px;line-height:16px;color:' + GREY_2 + ';word-break:break-all}',
        '.mc-barIndet .mc-barFill{width:34%;animation:mc-indet 1.15s ease-in-out infinite}',
        '@keyframes mc-indet{0%{margin-left:-34%}100%{margin-left:100%}}',
        // 上传卡：选择按钮 / 拖动上传按钮 / 「或直接填路径」折叠区；拖拽区本体在上传面板里
        '.mc-pickRow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
        '.mc-sep{border:0;border-top:0.5px solid ' + LINE + ';height:0;margin:2px 0}',
        // 拖拽区：上传面板里那一块（卡片里不再有）；虚线 + 拖过时的高亮。
        '.mc-drop{box-sizing:border-box;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;min-height:96px;padding:16px 14px;border:1.5px dashed ' + LINE + ';border-radius:12px;background:transparent;text-align:center}',
        '.mc-dropActive{border-color:' + GREY_2 + ';background:' + LAYER_2 + '}',
        '.mc-dropText{font-size:13px;line-height:19px;color:' + GREY_2 + '}',
        '.mc-dropActive .mc-dropText{color:' + GREY_1 + '}',
        '.mc-dropHint{font-size:11px;line-height:16px;color:' + GREY_2 + '}',
        // 上传面板：盖住整屏的浮层 + 居中面板。菜单的 z-index 是 80，这里必须更高。
        '.mc-overlay{position:fixed;inset:0;z-index:200;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(0,0,0,.42)}',
        '.mc-panel{box-sizing:border-box;display:flex;flex-direction:column;gap:12px;width:min(520px,100%);max-height:calc(100vh - 32px);overflow-y:auto;padding:18px 20px;border:0.5px solid ' + LINE + ';border-radius:14px;background:var(--dsw-alias-bg-layer-3,#ffffff);color:' + GREY_1 + ';box-shadow:0 18px 48px rgba(0,0,0,.30)}',
        '.mc-panelHead{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}',
        '.mc-panelTitle{min-width:0;font-size:15px;font-weight:600;line-height:22px;margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.mc-panelClose{flex:none;width:28px;height:28px;padding:0;justify-content:center}',
        '.mc-panelFoot{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
        // 面板里的拖拽区是主角：比卡片里那一版更高。
        '.mc-panel .mc-drop{min-height:150px}',
        '.mc-scanBox{display:flex;flex-direction:column;align-items:center;gap:10px;padding:22px 16px;border:0.5px dashed ' + LINE + ';border-radius:12px;background:' + LAYER_1 + '}',
        '.mc-scanSpinner{font-size:26px;line-height:1;color:' + GREY_2 + ';animation:mc-spin 1.4s linear infinite}',
        '@keyframes mc-spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}',
        '.mc-scanText{font-size:13px;line-height:19px;color:' + GREY_1 + ';text-align:center}',
        '.mc-securityNote{margin:8px 0 0;font-size:11px;line-height:16px;color:' + GREY_2 + '}',
        '.mc-moveBar{display:flex;align-items:center;gap:8px;min-width:0}',
        '.mc-movePath{min-width:0;flex:1;font-size:12px;line-height:18px;color:' + GREY_2 + ';overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.mc-moveList{display:flex;flex-direction:column;gap:2px;max-height:280px;overflow-y:auto;padding:2px}',
        '.mc-moveRow{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;box-sizing:border-box;padding:8px 10px;border:0;border-radius:8px;background:transparent;color:inherit;font-size:13px;text-align:left;cursor:pointer}',
        '.mc-moveRow:hover{background:' + LAYER_2 + '}',
        '.mc-moveRowDisabled{opacity:.45;cursor:not-allowed}',
        '.mc-moveTag{flex:none;font-size:11px;color:' + DANGER + '}',
        '.mc-linkBtn{appearance:none;border:0;background:transparent;font:inherit;font-size:12px;line-height:18px;color:' + GREY_2 + ';cursor:pointer;padding:2px 4px;margin-left:-4px;border-radius:6px;align-self:flex-start;text-align:left}',
        '.mc-linkBtn:hover{background:' + LAYER_2 + ';color:' + GREY_1 + '}',
        // 浏览器 → Host 的逐文件上行进度
        '.mc-urlLines{display:flex;flex-direction:column;gap:7px}',
        '.mc-urlLine{display:flex;flex-direction:column;gap:4px}',
        '.mc-urlLineHead{display:flex;align-items:baseline;gap:8px;font-size:12px;line-height:17px;color:' + GREY_2 + '}',
        '.mc-urlLineName{min-width:0;flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.mc-urlLinePct{flex:none;font-variant-numeric:tabular-nums}',
        '.mc-urlLineErr{color:' + DANGER + '}',
        '@media (prefers-color-scheme: dark){.mc-menu{background:var(--dsw-alias-bg-layer-3,#23262b)}.mc-panel{background:var(--dsw-alias-bg-layer-3,#23262b)}.mc-crumb{background:var(--dsw-alias-bg-layer-2,#1e2126)}}',
        '.mc-footer{font-size:11px;line-height:17px;color:' + GREY_2 + ';text-align:center}',
        // 登录页：标签栏 + 账号密码表单（只追加，不改上面任何一条）
        '.mc-tabs{display:flex;align-items:center;gap:4px;border-bottom:0.5px solid ' + LINE + ';margin:-2px 0 2px}',
        '.mc-tab{appearance:none;font:inherit;font-size:13px;line-height:19px;cursor:pointer;border:0;border-bottom:2px solid transparent;background:transparent;color:' + GREY_2 + ';padding:8px 12px;margin-bottom:-1px;border-radius:8px 8px 0 0;transition:color .14s ease,background-color .14s ease,border-color .14s ease}',
        '.mc-tab:hover{background:' + LAYER_2 + ';color:' + GREY_1 + '}',
        '.mc-tabActive{color:' + GREY_1 + ';font-weight:600;border-bottom-color:' + GREY_1 + '}',
        '.mc-tabActive:hover{background:' + LAYER_2 + ';color:' + GREY_1 + '}',
        '.mc-tabPanel{display:flex;flex-direction:column;gap:12px}',
        '.mc-pwWrap{position:relative;display:flex;align-items:center}',
        '.mc-pwWrap .mc-input{padding-right:40px}',
        '.mc-pwToggle{position:absolute;right:4px;top:50%;transform:translateY(-50%);appearance:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:6px;background:transparent;color:' + GREY_2 + ';font-size:14px;line-height:1;cursor:pointer}',
        '.mc-pwToggle:hover{background:' + LAYER_2 + ';color:' + GREY_1 + '}',
        '.mc-checkRow{display:flex;align-items:flex-start;gap:8px;font-size:12px;line-height:18px;color:' + GREY_1 + ';cursor:pointer}',
        '.mc-checkRow input{margin:2px 0 0;flex:none;accent-color:' + GREY_2 + '}',
        '.mc-checkText{min-width:0}',
        '.mc-formNote{font-size:11px;line-height:17px;color:' + GREY_2 + ';margin:0;word-break:break-word}',
        '.mc-submitRow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
        '.mc-submit{justify-content:center;min-width:132px}',

        // ================================================================
        // 资源管理器布局（0.3.0）
        //
        // 目标：像 Windows 资源管理器那样「左边目录树 + 右边内容」，
        // 并且整块区域要**撑满**插件面板（不再是一条条卡片往下堆）。
        //
        // 高度链条很重要：外层 .mc-explorer 必须是 flex 列 + min-height:0，
        // 里面的滚动区才能正确收缩。任何一环忘了 min-height:0，
        // 滚动区就会把父元素顶高、整页出现双滚动条。
        // ================================================================
        // 整页不再居中、不再滚动：由内部各区域自己滚。
        // min-height 写 100% 做兜底：万一宿主给的外层没有确定高度，
        // height:100% 会退化成 auto（塌成内容高），面板就「撑不满」了。
        '.mc-root-ide{height:100%;min-height:100%;overflow:hidden;padding:0;align-items:stretch;gap:0}',
        '.mc-root-ide>*{max-width:none}',

        // 外壳：纵向 = 顶部栏 / 中间主体 / 底部传输条
        // --mc-right-w 是「右上角容量条」和「搜索框」共用的宽度：
        // 用同一个变量，两者永远同宽，右边缘也永远对齐；窗口变窄时一起缩，
        // 这样按钮 + 容量条才能塞进一行。
        // 🔴 flex:1 1 0 + min-height:0 是必须的：作为 .mc-root-ide（flex column）的子项，
        // 只写 height:100% 会被 flex 算法忽略，结果被内容撑开十倍、列表永远不滚。
        '.mc-explorer{position:relative;flex:1 1 0;display:flex;flex-direction:column;height:100%;min-height:0;width:100%;box-sizing:border-box;overflow:hidden;--mc-right-w:240px}',
        '@media (max-width:1180px){.mc-explorer{--mc-right-w:190px}}',
        '@media (max-width:980px){.mc-explorer{--mc-right-w:150px}}',
        '.mc-root-ide .mc-explorer{max-width:none}',

        // ---- 顶部工具条 ----
        // 注意：这里**不要** border-bottom —— 底部那条线由容量条自己画。
        '.mc-exTop{flex:none;display:flex;flex-direction:column;gap:0}',

        // ---- 容量条：顶部栏底部那条贯通的粗进度线（替代原来的浅横线）----
        // 文字压在条里居中，白字 + 深色描边：
        //   · 已用段是品牌色（较深），白字清楚；
        //   · 未用段是浅灰底，靠描边把白字托出来。
        // 所以亮色 / 暗色主题下都能读，不会「白字压在浅色上消失」。
        '.mc-exQuotaLine{position:relative;flex:none;height:15px;overflow:hidden;background:' + LAYER_2 + '}',
        '.mc-exQuotaLineFill{position:absolute;left:0;top:0;bottom:0;background:var(--dsw-alias-brand-primary,#4f8cff);transition:width .35s ease}',
        '.mc-exQuotaLineText{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:0 8px;font-size:10px;line-height:1;font-weight:600;letter-spacing:.2px;color:#fff;text-shadow:0 1px 2px rgba(0,0,0,.72),0 0 3px rgba(0,0,0,.55);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none;font-variant-numeric:tabular-nums}',
        // 第一行：账号 / 按钮 / 容量条 三者同一水平线（align-items:center = 同高对齐）。
        // 塞得下的关键：左边账号区允许收缩（flex:1 1 0 + min-width:0），
        // 右边按钮组和容量条都是 flex:none —— 空间不够时压账号区，绝不折行。
        '.mc-exTopRow{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:9px clamp(10px,1.6vw,18px);flex-wrap:nowrap;min-width:0}',
        // 账号区：纵向三行（手机号 / 有效期 / 下载目录），保持原来的高度
        '.mc-exTopLeft{display:flex;flex-direction:column;gap:3px;flex:1 1 0;min-width:0;overflow:hidden}',
        // 有效期：一行小字
        '.mc-exExpiry{display:flex;align-items:baseline;gap:4px;min-width:0;font-size:11px;line-height:16px;color:' + GREY_2 + ';font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
        // 右上：按钮 + 容量条横向一排，不换行、不收缩
        '.mc-exTopRight{display:flex;align-items:center;gap:6px;flex:0 0 auto;flex-wrap:nowrap;min-width:0;align-self:flex-start}',
        '.mc-exTopRight .mc-btn{flex:none;white-space:nowrap}',
        // 真的挤不下时才折行（很窄的窗口）
        '@media (max-width:720px){.mc-exTopRow{flex-wrap:wrap}.mc-exTopRight{width:100%;justify-content:flex-start}}',
        // 容量条：和搜索框同宽（240px），不再居中、不再占满

        // 账号行：名字 + 铅笔 + 有效期
        '.mc-exAcct{display:flex;align-items:center;gap:6px;min-width:0;font-size:13px;line-height:19px;font-weight:600}',
        '.mc-exAcctName{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.mc-exAcctMasked{font-size:11px;line-height:15px;font-weight:400;color:' + GREY_2 + '}',
        '.mc-exAcctEdit{flex:none;appearance:none;border:0;background:transparent;color:' + GREY_2 + ';font-size:11px;line-height:1;padding:2px 3px;border-radius:4px;cursor:pointer}',
        '.mc-exAcctEdit:hover{background:' + LAYER_2 + ';color:' + GREY_1 + '}',
        '.mc-exExpiryWarn{color:' + DANGER + '}',
        // 下载目录小按钮：带框、可点。
        // ⚠️ 必须限宽：路径很长（C:\Users\xxx\Downloads\dsh-mcloud），
        // 不限的话这个框会把左上角撑得很长，还挤压右边的按钮。
        // self-start 让它按内容收缩，max-width 兜住上限，超出部分用省略号。
        '.mc-exChip{appearance:none;font:inherit;display:inline-flex;align-items:center;gap:6px;box-sizing:border-box;border:0.5px solid ' + LINE + ';border-radius:6px;background:' + LAYER_1 + ';color:' + GREY_2 + ';font-size:11px;line-height:16px;padding:3px 8px;cursor:pointer;max-width:min(100%,230px);min-width:0;align-self:flex-start;transition:background-color .14s ease,color .14s ease,border-color .14s ease}',
        '.mc-exChip:hover{background:' + LAYER_2 + ';color:' + GREY_1 + ';border-color:' + GREY_2 + '}',
        '.mc-exChipIcon{flex:none;font-size:11px;line-height:1;opacity:.9}',
        '.mc-exChipLabel{flex:none;font-weight:600}',
        '.mc-exChipValue{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left;font-variant-numeric:tabular-nums}',

        // 容量条（顶部居中）

        // 第二行：工具条（返回 / 路径 / 搜索 / 新建）
        // 第二行工具条：不换行（换行会把搜索框挤到第三行）
        '.mc-exTools{display:flex;align-items:center;gap:6px;flex-wrap:nowrap;padding:0 clamp(10px,1.6vw,18px) 8px}',
        '.mc-exToolsGrow{flex:1 1 0;min-width:0;overflow:hidden}',

        // 搜索框
        // 搜索框：固定 240px —— 和上一行的容量条严格同宽，
        // 这样两者的右边缘能对齐（一个在上、一个在下）。
        '.mc-exSearch{position:relative;display:flex;align-items:center;gap:0;flex:0 0 var(--mc-right-w);width:var(--mc-right-w);min-width:0}',
        '@media (max-width:720px){.mc-exSearch{flex:1 1 100%;width:auto}}',
        '.mc-exSearchInput{box-sizing:border-box;width:100%;font:inherit;font-size:12px;line-height:17px;color:' + GREY_1 + ';background:transparent;border:0.5px solid ' + LINE + ';border-radius:7px;padding:4px 26px 4px 8px}',
        '.mc-exSearchInput::placeholder{color:' + GREY_2 + '}',
        '.mc-exSearchClear{position:absolute;right:2px;top:50%;transform:translateY(-50%);appearance:none;display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;padding:0;border:0;border-radius:5px;background:transparent;color:' + GREY_2 + ';font-size:13px;line-height:1;cursor:pointer}',
        '.mc-exSearchClear:hover{background:' + LAYER_2 + ';color:' + GREY_1 + '}',

        // ---- 中部主体：左树 + 右列表 ----
        '.mc-exBody{flex:1 1 0;display:flex;min-height:0;overflow:hidden}',
        // 左树
        // 左树：宽度由 CSS 自适应，拖过之后由 inline style 固定
        '.mc-exTree{flex:none;display:flex;flex-direction:column;min-height:0;width:clamp(150px,19vw,240px);border-right:0.5px solid ' + LINE + '}',
        // 拖动中的分隔条：6px 热区 + 中间 2px 竖线
        // 热区给到 14px：6px 太窄，鼠标很难精确落在上面（用户反馈要拖到边上去才生效）。
        // 视觉上仍然是中间那条 1px 的线，只是可抓取范围宽了。
        '.mc-exSplitter{flex:none;position:relative;width:14px;margin-left:-7px;margin-right:-7px;cursor:col-resize;z-index:6;display:flex;align-items:center;justify-content:center;touch-action:none}',
        '.mc-exSplitterBar{width:1px;height:100%;background:' + LINE + ';opacity:0;border-radius:1px;transition:opacity .12s ease,background-color .12s ease,width .12s ease}',
        // 悬停时才显形，平时不打扰
        '.mc-exSplitter:hover .mc-exSplitterBar{opacity:1;width:2px;background:' + GREY_2 + '}',
        '.mc-exSplitterActive .mc-exSplitterBar{opacity:1;width:2px;background:' + GREY_1 + '}',
        // 拖动时禁掉整页选中（否则会拖出一片蓝色选区）
        '.mc-exResizing,.mc-exResizing *{user-select:none !important;cursor:col-resize !important}',
        // 窄屏时收起左树（靠 localStorage 记住用户选择）
        '.mc-exTreeHidden{display:none}',
        '.mc-exTreeHead{flex:none;display:flex;align-items:center;justify-content:space-between;gap:6px;height:29px;box-sizing:border-box;padding:0 10px;font-size:11px;line-height:16px;color:' + GREY_2 + ';border-bottom:0.5px solid ' + LINE + '}',
        // overscroll-behavior:contain —— 滚到底别把滚动传给外层对话页
        '.mc-exTreeScroll{flex:1 1 0;min-height:0;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;padding:4px 4px 10px}',
        '.mc-exTreeNode{display:flex;align-items:center;gap:3px;min-width:0;border-radius:6px}',
        '.mc-exTreeNode:hover{background:' + LAYER_1 + '}',
        '.mc-exTreeNodeActive{background:' + LAYER_2 + '}',
        // 箭头格子：宽度恒定 14px，任何状态都不变，所以行不会跳
        '.mc-exTreeToggle{flex:none;appearance:none;display:inline-flex;align-items:center;justify-content:center;width:14px;min-width:14px;height:20px;padding:0;border:0;background:transparent;color:' + GREY_2 + ';cursor:pointer;border-radius:4px}',
        '.mc-exTreeToggle:hover:not(:disabled){color:' + GREY_1 + ';background:' + LAYER_2 + '}',
        '.mc-exTreeToggle:disabled{cursor:default;opacity:.5}',
        '.mc-exCaretSlot{display:inline-flex;align-items:center;justify-content:center;width:10px;height:10px;flex:none}',
        // SVG 折角：收起指向右，展开转 90°，带过渡。
        // 颜色比普通文字淡一档，但悬停整行会变亮 —— 平时不抢戏，需要时看得见。
        '.mc-exCaret{display:block;color:' + GREY_2 + ';opacity:1;transition:transform .16s cubic-bezier(.4,0,.2,1),color .12s ease}',
        '.mc-exCaretOpen{transform:rotate(90deg)}',
        '.mc-exTreeNode:hover .mc-exCaret,.mc-exTreeToggle:hover .mc-exCaret{color:' + GREY_1 + '}',
        // 加载中的小转圈（和箭头同尺寸，不撑开布局）
        '.mc-exTreeSpinner{display:block;width:9px;height:9px;box-sizing:border-box;border:1.2px solid currentColor;border-top-color:transparent;border-radius:50%;opacity:.6;animation:mc-exSpin .7s linear infinite}',
        '@keyframes mc-exSpin{to{transform:rotate(360deg)}}',
        // 子节点容器：展开时淡入，避免"啪"一下出现
        '.mc-exTreeKids{animation:mc-exTreeIn .14s ease-out}',
        '@keyframes mc-exTreeIn{from{opacity:0}to{opacity:1}}',
        '.mc-exTreeLabel{flex:1 1 auto;min-width:0;appearance:none;display:flex;align-items:center;gap:5px;border:0;background:transparent;font:inherit;font-size:12px;line-height:18px;color:' + GREY_1 + ';text-align:left;padding:3px 4px;border-radius:5px;cursor:pointer;overflow:hidden}',
        '.mc-exTreeIcon{flex:none;font-size:12px;line-height:1}',
        '.mc-exTreeName{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.mc-exTreeLoading{flex:none;font-size:10px;color:' + GREY_2 + '}',
        // 树里的「继续加载」：比正常节点淡，明确是占位而不是真目录

        // 右列表
        '.mc-exMain{flex:1 1 0;display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden}',
        // 列头（像资源管理器那样）
        '.mc-exCols{position:relative;flex:none;display:grid;grid-template-columns:minmax(0,1fr) var(--mc-col-size,84px) var(--mc-col-time,132px);align-items:stretch;gap:0;height:29px;padding:0;box-sizing:border-box;border-bottom:0.5px solid ' + LINE + ';font-size:11px;line-height:16px;color:' + GREY_2 + ';user-select:none}',
        // ⚠️ 用「面板自身宽度」而不是视口宽度判断：对话区可能很窄，但整个浏览器窗口很宽，
        // 媒体查询（基于视口）在这种布局下会失效，三列直接挤成一团。
        // 这里由 JS 量 .mc-exMain 的宽度挂上 mc-narrow 类。
        '.mc-exMain.mc-narrow .mc-exCols{grid-template-columns:minmax(0,1fr) var(--mc-col-size,72px)}',
        '.mc-exMain.mc-narrow .mc-exColsTime{display:none}',
        '.mc-exMain.mc-narrow .mc-exColHandleTime{display:none}',
        '.mc-exColsName{display:flex;align-items:center;min-width:0;padding:0 8px 0 clamp(8px,1.2vw,14px);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        // 「大小」左右两条竖线（用户要求），同时也是拖动把手的视觉落点
        '.mc-exColsSize{display:flex;align-items:center;justify-content:flex-end;padding:0 8px;border-left:0.5px solid ' + LINE + ';border-right:0.5px solid ' + LINE + ';overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.mc-exColsTime{display:flex;align-items:center;justify-content:flex-end;padding:0 clamp(8px,1.2vw,14px) 0 8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        // 滚动列表：撑满剩余高度，自己滚
        '.mc-exScroll{flex:1 1 0;min-height:0;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;padding:0 0 6px}',
        '.mc-exRows{display:flex;flex-direction:column}',
        // 行：网格列对齐列头。
        // 不要边框 —— 资源管理器里行是「无框」的，靠整行背景色区分 hover / 选中，
        // 加边框会让列表看着像一堆小方块，又碎又脏。
        // 列宽拖动把手：热区 12px，视觉上是一条悬停才亮起来的竖线
        '.mc-exColHandle{position:absolute;top:0;bottom:0;width:12px;margin-left:-6px;cursor:col-resize;z-index:4;display:flex;align-items:center;justify-content:center;touch-action:none}',
        '.mc-exColHandleBar{width:1px;height:55%;background:transparent;border-radius:1px;transition:background-color .12s ease,height .12s ease,width .12s ease}',
        '.mc-exColHandle:hover .mc-exColHandleBar{width:2px;height:100%;background:' + GREY_2 + '}',
        '.mc-exColHandleActive .mc-exColHandleBar{width:2px;height:100%;background:' + GREY_1 + '}',
        // 拖动时禁掉列头的文字选中，避免拖出一片蓝
        '.mc-exColsResizing{user-select:none;cursor:col-resize}',
        '.mc-exRow{display:grid;grid-template-columns:minmax(0,1fr) var(--mc-col-size,84px) var(--mc-col-time,132px);align-items:stretch;gap:0;min-height:29px;padding:0;box-sizing:border-box;font-size:13px;line-height:19px;cursor:default;position:relative}',
        '.mc-exMain.mc-narrow .mc-exRow{grid-template-columns:minmax(0,1fr) var(--mc-col-size,72px)}',
        '.mc-exMain.mc-narrow .mc-exRowTime{display:none}',
        '.mc-exRow:hover{background:' + LAYER_1 + '}',
        // 选中：只把背景加深一档，左侧留一条短竖线做焦点提示（资源管理器的做法）
        '.mc-exRowSelected{background:' + LAYER_2 + '}',
        '.mc-exRowSelected::before{content:"";position:absolute;left:2px;top:50%;transform:translateY(-50%);width:2px;height:14px;border-radius:1px;background:' + GREY_2 + '}',
'.mc-exRowName{display:flex;align-items:center;gap:7px;min-width:0;padding:0 8px 0 calc(clamp(8px,1.2vw,14px) + 3px);overflow:hidden}',
        '.mc-exRowIcon{flex:none;font-size:13px;line-height:1}',
        '.mc-exRowText{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.mc-exRowTextBtn{appearance:none;border:0;background:transparent;font:inherit;color:inherit;text-align:left;padding:0;cursor:pointer;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        // 左右竖线要贯穿整列：列头有，每一行也必须有，否则只有表头那一段有线
        '.mc-exRowSize{display:flex;align-items:center;justify-content:flex-end;font-size:12px;color:' + GREY_2 + ';font-variant-numeric:tabular-nums;padding:0 8px;border-left:0.5px solid ' + LINE + ';border-right:0.5px solid ' + LINE + ';overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.mc-exRowTime{display:flex;align-items:center;justify-content:flex-end;font-size:12px;color:' + GREY_2 + ';font-variant-numeric:tabular-nums;padding:0 clamp(8px,1.2vw,14px) 0 8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        // 提示条 / 空态 / 加载
        '.mc-exBanner{flex:none;margin:6px clamp(8px,1.2vw,14px) 0;border-radius:8px;padding:6px 10px;font-size:12px;line-height:17px;background:' + LAYER_1 + ';word-break:break-word}',
        '.mc-exBannerErr{color:' + DANGER + '}',
        '.mc-exEmpty{padding:22px 12px;font-size:12px;line-height:18px;color:' + GREY_2 + ';text-align:center}',
        '.mc-exSearchHint{flex:none;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:5px clamp(8px,1.2vw,14px);font-size:11px;line-height:16px;color:' + GREY_2 + '}',
        '.mc-exSearchHit{font-weight:600;color:' + GREY_1 + '}',
        // 触底自动加载：底部只给一行极小的小字，不用按钮
        '.mc-exFeedFoot{display:flex;align-items:center;justify-content:center;gap:6px;padding:10px 0 4px;font-size:11px;line-height:16px;color:' + GREY_2 + ';opacity:.75}',
        '.mc-exFeedDot{width:4px;height:4px;border-radius:50%;background:currentColor;animation:mc-exFeedPulse 1.1s ease-in-out infinite}',
        '@keyframes mc-exFeedPulse{0%,100%{opacity:.25}50%{opacity:1}}',

        // ---- 底部传输条 ----
        // 平时完全隐形（就是一条和背景同色的细条）；
        // 有任务时进度填充出现颜色，跑满后停留 5 秒再淡出。
        // 高度会随「有没有任务」在 3px / 5px 之间切换：只改 CSS 变量不影响布局链条。
        // 传输条浮层：绝对定位钉在面板底部，任何视图/滚动位置都看得见。
        // 空闲时 pointer-events:none，不挡下面的点击。
        '.mc-exTransDock{position:absolute;left:0;right:0;bottom:0;z-index:20;pointer-events:none}',
        '.mc-exTransDockActive{pointer-events:auto}',
        // 空闲时也留一条极淡的底线 —— 不然用户根本不知道进度条在哪儿
        '.mc-exTrans{flex:none;position:relative;height:6px;background:' + LINE + ';transition:height .18s ease,background-color .25s ease}',
        '.mc-exTransActive{height:8px;background:transparent}',
        '.mc-exTransTrack{position:absolute;inset:0;overflow:hidden;background:transparent}',
        // 褪色要慢一点：1.5s 让颜色缓缓溶进背景，而不是「唰」一下没了
        '.mc-exTransFill{position:absolute;left:0;top:0;bottom:0;width:0;border-radius:0 3px 3px 0;background:transparent;transition:width .28s ease,background-color .3s ease,opacity 1.5s ease}',
        '.mc-exTransDraw{background:var(--dsw-alias-brand-primary,#4f8cff)}',
        '.mc-exTransDone{background:var(--dsw-alias-state-success-primary,#2ea043)}',
        '.mc-exTransErr{background:' + DANGER + '}',
        // 不确定进度（还不知道总量）：一小段来回跑，别让用户以为卡住了
        '.mc-exTransIndet{animation:mc-exTransIndet 1.2s ease-in-out infinite}',
        '@keyframes mc-exTransIndet{0%{width:8%;margin-left:0}50%{width:26%;margin-left:37%}100%{width:8%;margin-left:92%}}',
        '.mc-exTransBar{flex:none;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:5px clamp(10px,1.6vw,18px);border-top:0.5px solid ' + LINE + ';background:var(--dsw-alias-bg-layer-3,#ffffff);box-shadow:0 -4px 14px rgba(0,0,0,.10);font-size:11px;line-height:16px;color:' + GREY_2 + ';font-variant-numeric:tabular-nums;transition:opacity 1.5s ease}',
        '.mc-exTransBarFade{opacity:0}',
        '.mc-exTransSummary{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.mc-exTransActions{flex:none;display:flex;align-items:center;gap:6px}',

        // ---- 弹层（下载目录 / 选择目录）----
        '.mc-exModalHead{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}',
        '.mc-exModalTitle{font-size:14px;font-weight:600;line-height:21px;margin:0}',
        '.mc-exModalRow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
        '.mc-exModalRow .mc-input{flex:1 1 200px;min-width:0}',
        '.mc-exModalNote{font-size:11px;line-height:17px;color:' + GREY_2 + ';margin:0;word-break:break-word}',

        // ---- 传输记录 ----
        // 按钮上只有文字（不再放时钟图标），所以**任何宽度都不能把文字藏掉**，
        // 否则窄屏会变成一个空白按钮。窄屏时改成更短的词。
        '.mc-exHistoryBtn{display:inline-flex;align-items:center;gap:5px;position:relative}',
        '.mc-exHistoryLabel{display:inline}',
        '.mc-exHistoryLabelShort{display:none}',
        '@media (max-width:960px){.mc-exHistoryLabel{display:none}.mc-exHistoryLabelShort{display:inline}}',
        // 有任务在跑时按钮上一个小圆点
        '.mc-exHistoryDot{width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-brand-primary,#4f8cff);animation:mc-exFeedPulse 1.1s ease-in-out infinite}',
        // 弹层自身不滚，让里面的列表滚 —— 否则内外两层都能滚，滚动手感很怪
        '.mc-exHistPanel{width:min(560px,100%);overflow:hidden}',
        // 列表区自己滚：flex:1 + min-height:0 才能在高面板里正确收缩
        '.mc-exHistBody{display:flex;flex-direction:column;gap:14px;flex:1 1 auto;min-height:0;max-height:min(62vh,470px);overflow-y:auto;overscroll-behavior:contain;padding-right:4px}',
        // 细一点的滚动条，别抢视觉
        '.mc-exHistBody::-webkit-scrollbar{width:8px}',
        '.mc-exHistBody::-webkit-scrollbar-thumb{background:' + LAYER_2 + ';border-radius:4px}',
        '.mc-exHistBody::-webkit-scrollbar-thumb:hover{background:' + GREY_2 + '}',
        '.mc-exHistBody::-webkit-scrollbar-track{background:transparent}',
        '.mc-exHistEmpty{padding:26px 12px;font-size:12px;line-height:18px;color:' + GREY_2 + ';text-align:center}',
        '.mc-exHistSection{display:flex;flex-direction:column;gap:2px}',
        '.mc-exHistSectionHead{font-size:11px;line-height:16px;color:' + GREY_2 + ';font-weight:600;padding:0 0 4px}',
        '.mc-exHistItem{display:flex;flex-direction:column;gap:3px;padding:7px 8px;border-radius:7px}',
        '.mc-exHistItem:hover{background:' + LAYER_1 + '}',
        '.mc-exHistRow{display:flex;align-items:center;gap:7px;min-width:0}',
        // 图标：上传绿、下载蓝，一眼分清方向
        '.mc-exHistIcon{flex:none;display:inline-flex;align-items:center;justify-content:center;width:12px;height:14px;font-size:11px;line-height:1;color:' + GREY_2 + '}',
        '.mc-exHistIconUp{color:var(--dsw-alias-state-success-primary,#2ea043)}',
        '.mc-exHistIconDown{color:var(--dsw-alias-brand-primary,#4f8cff)}',
        '.mc-exHistName{flex:1 1 auto;min-width:0;font-size:12px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.mc-exHistState{flex:none;font-size:11px;line-height:16px;color:' + GREY_2 + '}',
        '.mc-exHistStateOk{color:var(--dsw-alias-state-success-primary,#2ea043)}',
        '.mc-exHistStateErr{color:' + DANGER + '}',
        '.mc-exHistMeta{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11px;line-height:15px;color:' + GREY_2 + ';font-variant-numeric:tabular-nums}',
        '.mc-exHistBar{position:relative;height:3px;border-radius:999px;overflow:hidden;background:' + LAYER_2 + '}',
        '.mc-exHistBarFill{height:100%;border-radius:999px;background:var(--dsw-alias-brand-primary,#4f8cff);transition:width .25s ease}',
        '.mc-exHistErr{font-size:11px;line-height:15px;color:' + DANGER + ';overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',

        // 极窄屏：左树会让列表没地方放，直接收起来（用户可用顶栏 ◀ 手动开）
        '@media (max-width:520px){.mc-exTree{width:132px}}',
        // 高 DPI / 小高度：顶部栏压缩一点，给列表让高度
        '@media (max-height:520px){.mc-exTopRow{padding:5px clamp(8px,1.2vw,12px)}.mc-exTools{padding-bottom:5px}.mc-exTransBar{padding:2px clamp(8px,1.2vw,12px)}}',
      ].join('')
      var CSS_ID = 'dsh-mcloud/panel.css'
      function ensureStyle() {
        try {
          if (typeof document === 'undefined' || !document.head) return
          if (document.getElementById(CSS_ID) !== null) return
          if (document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_ID) + ']') !== null) return
          var tag = document.createElement('style')
          tag.id = CSS_ID
          tag.dataset.plugin = 'dsh-mcloud'
          tag.dataset.pluginCss = CSS_ID
          tag.textContent = CSS_TEXT
          document.head.appendChild(tag)
        } catch (failure) {
          logWarn('style injection failed', failure)
        }
      }

      // ---------------------------------------------------------------- 格式化
      /** B / KB / MB / GB / TB，1 位小数。 */
      function formatBytes(value) {
        var n = Number(value)
        if (!isFinite(n) || n <= 0) return '0 B'
        var units = ['B', 'KB', 'MB', 'GB', 'TB']
        var index = 0
        var size = n
        while (size >= 1024 && index < units.length - 1) {
          size = size / 1024
          index += 1
        }
        if (index === 0) return Math.round(size) + ' B'
        return size.toFixed(1) + ' ' + units[index]
      }

      function pad2(value) {
        return String(value).padStart(2, '0')
      }

      /** 本地时间 YYYY-MM-DD HH:mm；认不出来就原样显示。 */
      function formatDateTime(value) {
        if (value === null || value === undefined || value === '') return '—'
        var date = new Date(value)
        if (isNaN(date.getTime())) return String(value)
        return (
          date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) +
          ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes())
        )
      }

      function messageOf(failure) {
        if (!failure) return 'unknown error'
        if (failure.message) return String(failure.message)
        return String(failure)
      }

      // ---------------------------------------------------------------- 本机路径
      /**
       * 目录 + 名字 → 本机路径。
       *
       * 目录里出现 `\`（或者像 `D:` 这样的盘符）就按 Windows 拼 `\`，否则按 POSIX 拼 `/`；
       * 先剪掉尾部分隔符，免得拼出 `D:\tmp\\a.zip`。目录为空就只回名字，
       * 由 Host 自己决定相对路径落在哪。
       */
      function joinPath(dir, name) {
        var base = dir === null || dir === undefined ? '' : String(dir).trim()
        base = base.replace(/[\\/]+$/, '')
        if (base === '') return String(name)
        var windows = base.indexOf('\\') >= 0 || /^[A-Za-z]:/.test(base)
        return base + (windows ? '\\' : '/') + String(name)
      }

      /** 路径最后一段（`D:\tmp\a.zip` → `a.zip`），只用来给提示起个好听的名字。 */
      function baseName(value) {
        var text = String(value === null || value === undefined ? '' : value)
        var cut = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'))
        return cut >= 0 ? text.slice(cut + 1) : text
      }

      var DOWNLOAD_DIR_KEY = 'dsh-mcloud/downloadDir'

      /**
       * 账号显示名（可选）：存 localStorage，只在浏览器里生效。
       * 只认字符串；拿不到就回空串 —— 调用方回退到脱敏手机号。
       */
      var DISPLAY_NAME_KEY = 'dsh-mcloud/displayName'

      function normalizeDisplayName(value) {
        return typeof value === 'string' ? value.trim() : ''
      }

      function readDisplayName() {
        try {
          if (typeof window === 'undefined' || !window.localStorage) return ''
          return normalizeDisplayName(window.localStorage.getItem(DISPLAY_NAME_KEY))
        } catch (failure) {
          logWarn('read display name failed', failure)
          return ''
        }
      }

      function writeDisplayName(value) {
        var next = normalizeDisplayName(value)
        try {
          if (typeof window === 'undefined' || !window.localStorage) return next
          if (next === '') window.localStorage.removeItem(DISPLAY_NAME_KEY)
          else window.localStorage.setItem(DISPLAY_NAME_KEY, next)
        } catch (failure) {
          logWarn('write display name failed', failure)
        }
        return next
      }

      /** 下载目录存在 localStorage 里；拿不到（隐私模式/没 window）就给空串。 */
      function readDownloadDir() {
        try {
          if (typeof window === 'undefined' || !window.localStorage) return ''
          var stored = window.localStorage.getItem(DOWNLOAD_DIR_KEY)
          return typeof stored === 'string' ? stored : ''
        } catch (failure) {
          logWarn('read download dir failed', failure)
          return ''
        }
      }

      function writeDownloadDir(value) {
        try {
          if (typeof window === 'undefined' || !window.localStorage) return
          window.localStorage.setItem(DOWNLOAD_DIR_KEY, String(value))
        } catch (failure) {
          logWarn('write download dir failed', failure)
        }
      }

      // ---------------------------------------------------------------- 传输
      /** 有任务在跑时 1s 拉一次 /transfers；没有就停表，绝不留一个空转的 interval。 */
      var TRANSFER_POLL_MS = 1000
      /** 面板上最多列几个任务（新的在前）。 */
      var TRANSFER_VISIBLE = 8
      /** 拖拽上传：那条「浏览器 → Host」进度行成功后还留几秒再消失。 */
      var URL_LINE_LINGER_MS = 4000
      /** 拖拽上传时最多同时显示几条进度行。 */
      var URL_LINE_VISIBLE = 8

      var PHASE_KEYS = {
        prepare: 'phasePrepare',
        hash: 'phaseHash',
        create: 'phaseCreate',
        upload: 'phaseUpload',
        scan: 'phaseScan',
        download: 'phaseDownload',
        complete: 'phaseComplete',
      }


      // ---------------------------------------------------------------- HTTP
      /** 非 2xx 与 { ok:false, error } 都转成 Error 抛出去；响应体不是 JSON 也当失败。 */
      function readJsonResponse(res) {
        return res.text().then(function (text) {
          var doc = null
          if (text) {
            try {
              doc = JSON.parse(text)
            } catch (parseFailure) {
              doc = null
            }
          }
          if (!res.ok || !doc || doc.ok === false) {
            throw new Error((doc && doc.error) || ('HTTP ' + res.status))
          }
          return doc
        })
      }

      /**
       * 统一出口：GET 不带自定义头，POST 一律 content-type + x-dsh-mcloud。
       * 非 2xx 与 { ok:false, error } 都转成 Error 抛出去。
       */
      /**
       * 客户端请求超时（比宿主的 25s 稍长，让宿主先报错）。
       *
       * 没有超时的话，一旦某个请求挂住（浏览器层面卡死、代理断了），
       * `listLoading` 会永久停在 true —— 而「加载更多」的守卫是
       * `if (listLoading) return`，于是列表从此再也不会续加载，
       * 用户滚到底就彻底卡住。大目录最容易撞上这个。
       */
      var CLIENT_TIMEOUT_MS = 30 * 1000

      function requestJson(method, path, body) {
        var init = { method: method, credentials: 'same-origin', cache: 'no-store' }
        if (method === 'POST') {
          init.headers = { 'content-type': 'application/json', 'x-dsh-mcloud': '1' }
          init.body = JSON.stringify(body || {})
        }
        try {
          if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
            init.signal = AbortSignal.timeout(CLIENT_TIMEOUT_MS)
          }
        } catch (failure) {
          /* 老浏览器没有 AbortSignal.timeout，退化成不超时 */
        }
        return fetch(BASE + path, init).then(readJsonResponse)
      }

      var api = {
        status: function () {
          return requestJson('GET', '/status')
        },
        auth: function (authorization, userDomainId) {
          return requestJson('POST', '/auth', { authorization: authorization, userDomainId: userDomainId })
        },
        /** 账号密码登录：密码只在这一跳里出现，Host 回 { ok, accountMasked, quota, quotaError, rememberPassword }。 */
        login: function (account, password, rememberPassword) {
          return requestJson('POST', '/login', {
            account: account,
            password: password,
            rememberPassword: rememberPassword === true,
          })
        },
        /** 本机是否存过密码（密码本身永远不回传，只回脱敏账号）。 */
        loginSaved: function () {
          return requestJson('GET', '/login/saved')
        },
        /** 扫码登录：开始 / 查进度 / 取消。 */
        scanStart: function () {
          return requestJson('POST', '/scan/start', {})
        },
        scanStatus: function () {
          return requestJson('GET', '/scan/status')
        },
        scanCancel: function () {
          return requestJson('POST', '/scan/cancel', {})
        },
        clearAuth: function () {
          return requestJson('POST', '/auth/clear', {})
        },
        list: function (parentFileId, cursor, pageSize) {
          var query =
            '/list?parentFileId=' + encodeURIComponent(parentFileId || '/') +
            '&cursor=' + encodeURIComponent(cursor || '')
          // 探测「这个目录有没有东西」时用 pageSize=1，比默认 10 更轻。
          if (pageSize) query += '&pageSize=' + encodeURIComponent(String(pageSize))
          return requestJson('GET', query)
        },
        /** 按文件名搜索：Host 端会从 parentFileId 往下走若干层。 */
        search: function (options) {
          var opts = options || {}
          return requestJson(
            'GET',
            '/search?keyword=' + encodeURIComponent(opts.keyword || '') +
              '&parentFileId=' + encodeURIComponent(opts.parentFileId || '/')
          )
        },
        /** 弹宿主机的系统「选择文件夹」对话框（选下载目录用）。 */
        pickDir: function () {
          return requestJson('POST', '/pick-dir', {})
        },
        /** 清空已结束的传输记录（只删记录，不删文件）。 */
        clearTransfers: function () {
          return requestJson('POST', '/transfers/clear', {})
        },
        mkdir: function (parentFileId, name) {
          return requestJson('POST', '/mkdir', { parentFileId: parentFileId, name: name })
        },
        /**
         * 「上传文件夹」专用：按相对路径把远端目录逐层建出来（Host 端会复用已存在的同名目录），
         * 回 { ok:true, fileId } —— fileId 是 path 最末一层那个目录的 id。
         */
        mkdirPath: function (parentFileId, path) {
          return requestJson('POST', '/mkdir-path', { parentFileId: parentFileId, path: path })
        },
        rename: function (fileId, name) {
          return requestJson('POST', '/rename', { fileId: fileId, name: name })
        },
        move: function (fileIds, toParentFileId) {
          return requestJson('POST', '/move', { fileIds: fileIds, toParentFileId: toParentFileId })
        },
        remove: function (fileIds) {
          return requestJson('POST', '/remove', { fileIds: fileIds })
        },
        link: function (fileId) {
          return requestJson('POST', '/link', { fileId: fileId })
        },
        /**
         * 下面三个传输接口都是「200 + jobId」的异步任务：失败（含没授权）也会先回 200，
         * 之后才在任务里变成 state:'error' —— 所以真正的错误提示在传输面板上，不在 catch 里。
         */
        upload: function (localPath, parentFileId, name) {
          var body = { localPath: localPath, parentFileId: parentFileId }
          if (name) body.name = name
          return requestJson('POST', '/upload', body)
        },
        /** 整个本机文件夹交给 Host 扫描上传（POST /upload-folder → jobId）。 */
        uploadFolder: function (localPath, parentFileId) {
          return requestJson('POST', '/upload-folder', { localPath: localPath, parentFileId: parentFileId })
        },
        /**
         * 拖拽上传：body 是文件原始字节，不是 JSON —— 所以只能用 XMLHttpRequest
         * （fetch 拿不到「浏览器 → Host」这一段的上行进度）。
         * 成功 = HTTP 200 + { ok:true, jobId, name }；失败按 { ok:false, error } 抛出去。
         */
        uploadBody: function (file, parentFileId, onProgress) {
          return new Promise(function (resolve, reject) {
            var name = file && file.name ? String(file.name) : 'upload.bin'
            var url = BASE + '/upload-body?name=' + encodeURIComponent(name) +
              '&parentFileId=' + encodeURIComponent(parentFileId || '/')
            try {
              var xhr = new XMLHttpRequest()
              xhr.open('POST', url)
              xhr.setRequestHeader('content-type', 'application/octet-stream')
              xhr.setRequestHeader('x-dsh-mcloud', '1')
              if (xhr.upload && typeof onProgress === 'function') {
                xhr.upload.onprogress = function (event) {
                  if (!event || !event.lengthComputable) return
                  var total = Number(event.total) || 0
                  if (total <= 0) return
                  var percent = Math.min(100, Math.max(0, ((Number(event.loaded) || 0) / total) * 100))
                  try {
                    onProgress(percent)
                  } catch (failure) {
                    logWarn('upload progress handler failed', failure)
                  }
                }
              }
              xhr.onload = function () {
                var doc = null
                try {
                  doc = JSON.parse(xhr.responseText)
                } catch (parseFailure) {
                  doc = null
                }
                if (xhr.status !== 200 || !doc || doc.ok === false) {
                  reject(new Error((doc && doc.error) || ('HTTP ' + xhr.status)))
                  return
                }
                resolve(doc)
              }
              xhr.onerror = function () {
                reject(new Error('network error'))
              }
              xhr.onabort = function () {
                reject(new Error('upload aborted'))
              }
              xhr.send(file)
            } catch (failure) {
              reject(failure instanceof Error ? failure : new Error(messageOf(failure)))
            }
          })
        },
        download: function (fileId, localPath) {
          return requestJson('POST', '/download', { fileId: fileId, localPath: localPath })
        },
        downloadFolder: function (folderId, localPath) {
          return requestJson('POST', '/download-folder', { folderId: folderId, localPath: localPath })
        },
        cancelTransfer: function (jobId) {
          return requestJson('POST', '/transfer/cancel', { jobId: jobId })
        },
        transfers: function () {
          return requestJson('GET', '/transfers')
        },
        transfer: function (jobId) {
          return requestJson('GET', '/transfers?jobId=' + encodeURIComponent(jobId))
        },
      }

      // ---------------------------------------------------------------- 小组件
      function KeyValue(props) {
        return h('div', { className: 'mc-kv' },
          h('span', { className: 'mc-kvLabel' }, props.label),
          h('span', { className: 'mc-kvValue' }, props.value)
        )
      }

      // ---------------------------------------------------------------- 面板
      function createPanel(t) {
        return function MobileCloudPanel() {
          // 状态卡
          var statusState = React.useState(null)
          var status = statusState[0]
          var setStatus = statusState[1]
          var statusErrorState = React.useState('')
          var statusError = statusErrorState[0]
          var setStatusError = statusErrorState[1]
          var statusLoadingState = React.useState(true)
          var statusLoading = statusLoadingState[0]
          var setStatusLoading = statusLoadingState[1]
          // 授权表单
          var authValueState = React.useState('')
          var authValue = authValueState[0]
          var setAuthValue = authValueState[1]
          var udValueState = React.useState('')
          var udValue = udValueState[0]
          var setUdValue = udValueState[1]
          var authBusyState = React.useState(false)
          var authBusy = authBusyState[0]
          var setAuthBusy = authBusyState[1]
          var authErrorState = React.useState('')
          var authError = authErrorState[0]
          var setAuthError = authErrorState[1]
          var authNoticeState = React.useState('')
          var authNotice = authNoticeState[0]
          var setAuthNotice = authNoticeState[1]
          var reauthOpenState = React.useState(false)
          var reauthOpen = reauthOpenState[0]
          var setReauthOpen = reauthOpenState[1]
          // 登录页：'scan' = 扫码登录，'login' = 账号密码
          var authTabState = React.useState('scan')
          var authTab = authTabState[0]
          var setAuthTab = authTabState[1]
          var loginAccountState = React.useState('')
          var loginAccount = loginAccountState[0]
          var setLoginAccount = loginAccountState[1]
          var loginPasswordState = React.useState('')
          var loginPassword = loginPasswordState[0]
          var setLoginPassword = loginPasswordState[1]
          var rememberPasswordState = React.useState(false)
          var rememberPassword = rememberPasswordState[0] // 默认不勾：密码只在登录时用一次
          var setRememberPassword = rememberPasswordState[1]
          var loginBusyState = React.useState(false)
          var loginBusy = loginBusyState[0]
          var setLoginBusy = loginBusyState[1]
          var loginErrorState = React.useState('')
          var loginError = loginErrorState[0]
          var setLoginError = loginErrorState[1]
          var loginNoticeState = React.useState('')
          var loginNotice = loginNoticeState[0]
          var setLoginNotice = loginNoticeState[1]
          var showPasswordState = React.useState(false)
          var showPassword = showPasswordState[0]
          var setShowPassword = showPasswordState[1]
          var savedHintState = React.useState('')
          var savedHint = savedHintState[0]
          var setSavedHint = savedHintState[1]

          // ------------------------------------------------------ 扫码登录状态
          // idle = 没开始；launching/waiting = 进行中；done = 成功；error/cancelled = 结束
          var scanStateState = React.useState({ state: 'idle', phase: 'idle', message: '' })
          var scanState = scanStateState[0]
          var setScanState = scanStateState[1]
          var scanTimerRef = React.useRef(null)

          /** 停止轮询扫码进度。 */
          function stopScanPolling() {
            if (scanTimerRef.current !== null) {
              try {
                clearInterval(scanTimerRef.current)
              } catch (failure) {
                /* 已经清过 */
              }
              scanTimerRef.current = null
            }
          }

          /** 轮询 /scan/status，直到结束态。 */
          function startScanPolling() {
            stopScanPolling()
            var tick = function () {
              api.scanStatus()
                .then(function (doc) {
                  if (!doc || doc.ok !== true) return
                  setScanState({
                    state: doc.state || 'idle',
                    phase: doc.phase || 'idle',
                    message: doc.message || '',
                  })
                  if (doc.state === 'done') {
                    stopScanPolling()
                    // 扫码头像成功后刷新整个面板：状态、容量、文件列表
                    loadStatus().then(function () { reload() })
                  } else if (doc.state === 'error' || doc.state === 'cancelled') {
                    stopScanPolling()
                  }
                })
                .catch(function (failure) {
                  logWarn('scan status failed', failure)
                })
            }
            tick()
            scanTimerRef.current = setInterval(tick, 1200)
          }

          /** 开始扫码登录。 */
          function beginScan() {
            setLoginError('')
            setLoginNotice('')
            setScanState({ state: 'launching', phase: 'launching', message: '' })
            api.scanStart()
              .then(function (doc) {
                if (doc && doc.ok === false) {
                  setScanState({ state: 'error', phase: 'error', message: doc.error || '' })
                  setLoginError(doc.error || '')
                  return
                }
                // 服务端已经开跑，开始轮询
                startScanPolling()
              })
              .catch(function (failure) {
                const detail = messageOf(failure)
                setScanState({ state: 'error', phase: 'error', message: detail })
                setLoginError(t('actFailed', { detail: detail }))
                logWarn('scan start failed', failure)
              })
          }

          /** 取消扫码。 */
          function cancelScan() {
            api.scanCancel()
              .then(function () { setScanState({ state: 'cancelled', phase: 'cancelled', message: '' }) })
              .catch(function () { /* 忽略 */ })
            stopScanPolling()
          }

          // 面板卸载时别留下定时器
          React.useEffect(function () {
            return function () { stopScanPolling() }
          }, [])
          // 文件浏览
          var stackState = React.useState([])
          var stack = stackState[0]
          var setStack = stackState[1]
          var itemsState = React.useState([])
          var items = itemsState[0]
          var setItems = itemsState[1]
          var cursorState = React.useState(null)
          var nextCursor = cursorState[0]
          var setNextCursor = cursorState[1]
          var listLoadingState = React.useState(false)
          var listLoading = listLoadingState[0]
          var setListLoading = listLoadingState[1]
          var listErrorState = React.useState('')
          var listError = listErrorState[0]
          var setListError = listErrorState[1]
          var busyState = React.useState(false)
          var busy = busyState[0]
          var setBusy = busyState[1]
          var folderOpenState = React.useState(false)
          var folderOpen = folderOpenState[0]
          var setFolderOpen = folderOpenState[1]
          var folderNameState = React.useState('')
          var folderName = folderNameState[0]
          var setFolderName = folderNameState[1]
          var linkBusyState = React.useState('')
          var linkBusy = linkBusyState[0]
          var setLinkBusy = linkBusyState[1]
          // 下载目录 / 上传
          var downloadDirState = React.useState('')
          var downloadDir = downloadDirState[0]
          var setDownloadDir = downloadDirState[1]
          var uploadPathState = React.useState('')
          var uploadPath = uploadPathState[0]
          var setUploadPath = uploadPathState[1]
          // 账号显示名（可选，存 localStorage）
          var displayNameState = React.useState('')
          var displayName = displayNameState[0]
          var setDisplayName = displayNameState[1]
          var displayNameEditState = React.useState(false)
          var displayNameEdit = displayNameEditState[0]
          var setDisplayNameEdit = displayNameEditState[1]
          var displayNameDraftState = React.useState('')
          var displayNameDraft = displayNameDraftState[0]
          var setDisplayNameDraft = displayNameDraftState[1]
          var displayNameErrorState = React.useState('')
          var displayNameError = displayNameErrorState[0]
          var setDisplayNameError = displayNameErrorState[1]
          // 选择本机文件 / 文件夹（POST /pick）与拖拽上传
          var pickingState = React.useState(false)
          var picking = pickingState[0] // 系统对话框还开着，等用户作答
          var setPicking = pickingState[1]
          var pathOpenState = React.useState(false)
          var pathOpen = pathOpenState[0] // 「或直接填路径」折叠区
          var setPathOpen = pathOpenState[1]
          var dragOverState = React.useState(false)
          var dragOver = dragOverState[0]
          var setDragOver = dragOverState[1]
          var urlItemsState = React.useState([])
          var urlItems = urlItemsState[0] // 拖拽上传的逐文件上行进度
          var setUrlItems = urlItemsState[1]
          var dropNoteState = React.useState('')
          var dropNote = dropNoteState[0] // 拖到文件夹时的一句提示
          var setDropNote = dropNoteState[1]
          var jobBusyState = React.useState('')
          var jobBusy = jobBusyState[0] // 正在起任务的按钮：'' / item.id / 'upload'
          var setJobBusy = jobBusyState[1]
          var noticeState = React.useState('')
          var notice = noticeState[0] // 文件区的一行成功提示
          var setNotice = noticeState[1]
          // 传输面板
          var jobsState = React.useState([])
          var jobs = jobsState[0]
          var setJobs = jobsState[1]
          var cancelBusyState = React.useState('')
          var cancelBusy = cancelBusyState[0]
          var setCancelBusy = cancelBusyState[1]
          // 右键菜单：{ x, y, item|null, placed }，同一时刻最多一个
          var menuState = React.useState(null)
          var menu = menuState[0]
          var setMenu = menuState[1]
          // 上传面板：uploadOpen = 面板开着；uploadTarget = 打开那一刻钉住的目标目录 id/name。
          var uploadOpenState = React.useState(false)
          var uploadOpen = uploadOpenState[0]
          var setUploadOpen = uploadOpenState[1]
          var uploadTargetState = React.useState(null)
          var moveOpenState = React.useState(false)
          var moveSourceState = React.useState(null)
          var moveStackState = React.useState([])
          var moveItemsState = React.useState([])
          var moveCursorState = React.useState(null)
          var moveLoadingState = React.useState(false)
          var moveBusyState = React.useState(false)
          var moveErrorState = React.useState('')
          var moveNoteState = React.useState('')
          var moveOpen = moveOpenState[0]; var setMoveOpen = moveOpenState[1]
          var moveSource = moveSourceState[0]; var setMoveSource = moveSourceState[1]
          var moveStack = moveStackState[0]; var setMoveStack = moveStackState[1]
          var moveItems = moveItemsState[0]; var setMoveItems = moveItemsState[1]
          var moveCursor = moveCursorState[0]; var setMoveCursor = moveCursorState[1]
          var moveLoading = moveLoadingState[0]; var setMoveLoading = moveLoadingState[1]
          var moveBusy = moveBusyState[0]; var setMoveBusy = moveBusyState[1]
          var moveError = moveErrorState[0]; var setMoveError = moveErrorState[1]
          var moveNote = moveNoteState[0]; var setMoveNote = moveNoteState[1]
          var uploadTarget = uploadTargetState[0]
          var setUploadTarget = uploadTargetState[1]

          // ================================================================
          // 0.3.0 资源管理器：目录树 / 搜索 / 下载目录弹层 / 传输条动画
          // ================================================================
          /**
           * 左侧目录树。
           *
           * 结构：{ id, name, open, loading, loaded, children: [] }
           * 只有「展开过」的节点才去请求子目录 —— 网盘目录可能很多，
           * 一上来就把整棵树拉下来会让打开面板慢好几秒。
           */
          var treeRootState = React.useState({
            id: '/',
            name: '/',
            open: true,
            loading: false,
            loaded: false,
            children: [],
          })
          var treeRoot = treeRootState[0]
          var setTreeRoot = treeRootState[1]

          /** 左树是否显示（窄屏可手动收起）。 */
          var treeShownState = React.useState(true)
          var treeShown = treeShownState[0]
          var setTreeShown = treeShownState[1]

          /** 当前列表所对应的目录 id（右树的「焦点」）。 */
          var treeFocusIdState = React.useState('/')
          var treeFocusId = treeFocusIdState[0]
          var setTreeFocusId = treeFocusIdState[1]

          // 搜索
          var searchOpenState = React.useState(false)
          var searchOpen = searchOpenState[0]
          var setSearchOpen = searchOpenState[1]
          var searchKeywordState = React.useState('')
          var searchKeyword = searchKeywordState[0]
          var setSearchKeyword = searchKeywordState[1]
          var searchBusyState = React.useState(false)
          var searchBusy = searchBusyState[0]
          var setSearchBusy = searchBusyState[1]
          var searchItemsState = React.useState([])
          var searchItems = searchItemsState[0]
          var setSearchItems = searchItemsState[1]
          var searchNoteState = React.useState('')
          var searchNote = searchNoteState[0]
          var setSearchNote = searchNoteState[1]
          var searchErrorState = React.useState('')
          var searchError = searchErrorState[0]
          var setSearchError = searchErrorState[1]
          var searchSeqRef = React.useRef(0)

          // 下载目录弹层
          var dirModalState = React.useState(false)
          var dirModal = dirModalState[0]
          var setDirModal = dirModalState[1]
          var dirDraftState = React.useState('')
          var dirDraft = dirDraftState[0]
          var setDirDraft = dirDraftState[1]
          var dirPickBusyState = React.useState(false)
          var dirPickBusy = dirPickBusyState[0]
          var setDirPickBusy = dirPickBusyState[1]
          var dirErrorState = React.useState('')
          var dirError = dirErrorState[0]
          var setDirError = dirErrorState[1]

          /** 底部传输条：'idle' | 'draw' | 'done' | 'error'。 */
          var transPhaseState = React.useState('idle')
          var transPhase = transPhaseState[0]
          var setTransPhase = transPhaseState[1]
          /** 刚刚完成时停留 5 秒再渐变回透明。 */
          var transFadeRef = React.useRef(null)
          /** 上一次的整体进度，用来推动画。 */
          var transPercentState = React.useState(0)
          var transPercent = transPercentState[0]
          var setTransPercent = transPercentState[1]

          /** 当前选中的行 id（选中态只影响视觉）。 */
          var selectedIdState = React.useState('')
          var selectedId = selectedIdState[0]
          var setSelectedId = selectedIdState[1]

          /**
           * 列表滚动容器。
           *
           * 不用「加载更多」按钮：滚到底部就把下一批接上，
           * 这才是资源管理器的样子。用 ref 是为了在滚动回调里读到最新值。
           */
          var listScrollRef = React.useRef(null)
          /** 防重入：一次只允许一个「加载下一批」在飞。 */
          var loadMoreBusyRef = React.useRef(false)
          /** 滚到底部附近多少像素时开始预加载。 */
          var LOAD_MORE_THRESHOLD = 240

          /** 历史传输记录弹层。 */
          var historyOpenState = React.useState(false)
          var historyOpen = historyOpenState[0]
          var setHistoryOpen = historyOpenState[1]
          /** 清空记录进行中（防连点）。 */
          var historyBusyState = React.useState(false)
          var historyBusy = historyBusyState[0]
          var setHistoryBusy = historyBusyState[1]

          /**
           * 左树宽度（px）。
           *
           * null = 还没拖过，用 CSS 的自适应宽度（clamp）。
           * 用户拖动过之后就固定成他选的像素值，并记到 localStorage，
           * 下次打开还是这个宽度。
           */
          var treeWidthState = React.useState(null)
          var treeWidth = treeWidthState[0]
          var setTreeWidth = treeWidthState[1]
          /** 拖动中（用来加 cursor 和防止选中文字）。 */
          var resizingState = React.useState(false)
          var resizing = resizingState[0]
          var setResizing = resizingState[1]

          /**
           * 资源管理器根节点的实测高度（px）。
           *
           * 不用 CSS 的 height:100% —— 它在父容器没有确定高度时会静默失效，
           * 导致整个面板被内容撑开、列表滚不动、进度条被顶到最底下。
           * 这里直接量父容器的像素高度写死，最可靠。
           */
          var ideRootRef = React.useRef(null)
          var ideHeightState = React.useState(0)
          var ideHeight = ideHeightState[0]
          var setIdeHeight = ideHeightState[1]

          /**
           * 右侧列表的列宽（px）。
           *
           * 名称列是弹性的（占剩下的空间），大小 / 时间两列固定。
           * 列头里「大小」左右各有竖线，都能拖：拖左线改大小列宽，拖右线改时间列宽。
           * 下限见 COL_MIN_*，上限保证左边（名称列）至少还剩 NAME_MIN 宽 ——
           * 否则能把某一列拖到只剩一条线。
           */
          var COL_SIZE_DEFAULT = 84
          var COL_TIME_DEFAULT = 132
          var COL_SIZE_MIN = 64
          var COL_TIME_MIN = 88
          var COL_NAME_MIN = 120
          var colSizeState = React.useState(COL_SIZE_DEFAULT)
          var colSize = colSizeState[0]
          var setColSize = colSizeState[1]
          var colTimeState = React.useState(COL_TIME_DEFAULT)
          var colTime = colTimeState[0]
          var setColTime = colTimeState[1]
          /** 列头容器，用来量总宽算拖动边界。 */
          var colsRef = React.useRef(null)
          /**
           * 右侧主栏是否太窄（决定要不要把「修改时间」列藏掉）。
           *
           * 必须按**面板自身宽度**判断，不能用 @media —— 对话区可能只占窗口一小半，
           * 窗口很宽的时候媒体查询不会触发，三列就会挤在一起。
           */
          var mainNarrowState = React.useState(false)
          var mainNarrow = mainNarrowState[0]
          var setMainNarrow = mainNarrowState[1]
          var mainRef = React.useRef(null)
          /**
           * 列表滚动条的宽度（px）。
           *
           * 列头在滚动容器**外面**，行在**里面** —— 列表一旦出现滚动条，
           * 行的可用宽度就比列头少十几像素，名称列又是弹性的，于是两个固定列
           * 整体左移，竖线和表头错位。这里量出实际滚动条宽度补给列头。
           */
          var scrollbarWState = React.useState(0)
          var scrollbarW = scrollbarWState[0]
          var setScrollbarW = scrollbarWState[1]
          var colResizingState = React.useState('')
          var colResizing = colResizingState[0]
          var setColResizing = colResizingState[1]

          /**
           * 拖列头的竖线调整列宽。
           *
           * which: 'size' = 「大小」左侧那条线（拖它改大小列宽）
           *        'time' = 「大小」右侧那条线（拖它改时间列宽）
           *
           * 边界：每列都有自己的下限，并且永远给名称列留够 COL_NAME_MIN ——
           * 这样怎么拖都不会出现「某一列被压成一条线」。
           */
          function beginColResize(which, event) {
            if (event && typeof event.preventDefault === 'function') event.preventDefault()
            if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
            var startX = event && event.clientX ? event.clientX : 0
            var startSize = colSize
            var startTime = colTime
            var total = 0
            var node = colsRef.current
            if (node) {
              total = node.clientWidth || 0
            }
            if (!total) total = 600
            setColResizing(which)
            if (typeof document !== 'undefined' && document.body) {
              document.body.style.cursor = 'col-resize'
              document.body.style.userSelect = 'none'
            }

            function onMove(moveEvent) {
              if (moveEvent && typeof moveEvent.preventDefault === 'function') moveEvent.preventDefault()
              var delta = (moveEvent && moveEvent.clientX ? moveEvent.clientX : startX) - startX
              if (which === 'size') {
                // 往右拖 → 大小列变窄
                var next = startSize - delta
                var maxSize = total - COL_NAME_MIN - startTime
                if (maxSize < COL_SIZE_MIN) maxSize = COL_SIZE_MIN
                next = Math.max(COL_SIZE_MIN, Math.min(maxSize, next))
                setColSize(Math.round(next))
              } else {
                var nextTime = startTime - delta
                var maxTime = total - COL_NAME_MIN - startSize
                if (maxTime < COL_TIME_MIN) maxTime = COL_TIME_MIN
                nextTime = Math.max(COL_TIME_MIN, Math.min(maxTime, nextTime))
                setColTime(Math.round(nextTime))
              }
            }

            function onUp() {
              setColResizing('')
              if (typeof document !== 'undefined' && document.body) {
                document.body.style.cursor = ''
                document.body.style.userSelect = ''
              }
              if (typeof document !== 'undefined') {
                document.removeEventListener('mousemove', onMove, true)
                document.removeEventListener('mouseup', onUp, true)
              }
              if (typeof window !== 'undefined') {
                window.removeEventListener('mouseup', onUp, true)
              }
            }

            if (typeof document !== 'undefined') {
              document.addEventListener('mousemove', onMove, true)
              document.addEventListener('mouseup', onUp, true)
            }
            if (typeof window !== 'undefined') {
              window.addEventListener('mouseup', onUp, true)
            }
          }

          /** 双击竖线：两列都回到默认宽度。 */
          function resetColWidth() {
            setColSize(COL_SIZE_DEFAULT)
            setColTime(COL_TIME_DEFAULT)
          }

          /** 量主栏宽度，窄到放不下三列时收起「修改时间」列。 */
          React.useEffect(function () {
            if (!authorized) return
            var node = mainRef.current
            if (!node || typeof window === 'undefined') return

            function measureWidth() {
              var el = mainRef.current
              if (!el) return
              var w = el.clientWidth || 0
              var narrow = w > 0 && w < 620
              setMainNarrow(function (previous) {
                return previous === narrow ? previous : narrow
              })
            }

            measureWidth()
            var observer = null
            try {
              if (typeof ResizeObserver === 'function') {
                observer = new ResizeObserver(measureWidth)
                observer.observe(node)
              }
            } catch (failure) {
              observer = null
            }
            window.addEventListener('resize', measureWidth)
            var timers = [80, 300, 900].map(function (delay) {
              return setTimeout(measureWidth, delay)
            })
            return function () {
              for (var i = 0; i < timers.length; i += 1) clearTimeout(timers[i])
              window.removeEventListener('resize', measureWidth)
              if (observer) {
                try {
                  observer.disconnect()
                } catch (failure) {
                  /* 已断开 */
                }
              }
            }
          }, [authorized])

          /** 量滚动条宽度，补偿给列头。 */
          React.useEffect(function () {
            if (!authorized) return
            if (typeof window === 'undefined') return

            function measureScrollbar() {
              var el = listScrollRef.current
              if (!el) return
              var w = (el.offsetWidth || 0) - (el.clientWidth || 0)
              if (w < 0) w = 0
              if (w > 40) w = 40
              setScrollbarW(function (previous) {
                return previous === w ? previous : w
              })
            }

            measureScrollbar()
            var observer = null
            try {
              if (typeof ResizeObserver === 'function' && scrollRef.current) {
                observer = new ResizeObserver(measureScrollbar)
                observer.observe(listScrollRef.current)
              }
            } catch (failure) {
              observer = null
            }
            window.addEventListener('resize', measureScrollbar)
            var timers = [80, 300, 900].map(function (delay) {
              return setTimeout(measureScrollbar, delay)
            })
            return function () {
              for (var i = 0; i < timers.length; i += 1) clearTimeout(timers[i])
              window.removeEventListener('resize', measureScrollbar)
              if (observer) {
                try {
                  observer.disconnect()
                } catch (failure) {
                  /* 已断开 */
                }
              }
            }
          }, [authorized, items, nextCursor])

          // 请求序号：快速切目录时把旧响应丢掉。
          var seqRef = React.useRef(0)
          var pollTimerRef = React.useRef(null)
          var pollingRef = React.useRef(false)
          var fetchRef = React.useRef(null)
          var jobsRef = React.useRef([])
          var downloadDirReadyRef = React.useRef(false)
          var displayNameReadyRef = React.useRef(false)
          var uploadInputRef = React.useRef(null)
          var menuRef = React.useRef(null)
          var dragDepthRef = React.useRef(0)
          /** 上传面板的根节点，给 window 捕获阶段的拖放护栏判断「事件在不在面板里」。 */
          var dragGuardRef = React.useRef(null) // dragenter/leave 成对计数，免得划过子元素就闪
          var urlSeqRef = React.useRef(0)
          var urlTimersRef = React.useRef([])
          var focusUploadRef = React.useRef(false)
          // 上传面板：投放时用的「钉住的目录」（投放回调里读 ref，拿到的永远是最新一版）。
          var uploadTargetRef = React.useRef(null)
          /** GET /login/saved 只问一次：之后再挂载（重新授权等）不重复打。 */
          var loginSavedRef = React.useRef(false)

          var authorized = !!(status && status.authorized)
          var parentId = stack.length > 0 ? stack[stack.length - 1].id : '/'
          /** 脱敏手机号：Host 新版本才会给；没有就当没有（绝不回退成完整号码）。 */
          var accountMasked = status && typeof status.accountMasked === 'string' ? status.accountMasked.trim() : ''
          var hasAccount = accountMasked !== ''
          /** 显示名非空就盖住脱敏号码。 */
          var accountLabel = displayName !== '' ? displayName : accountMasked

          function loadStatus() {
            setStatusLoading(true)
            return api.status()
              .then(function (doc) {
                setStatus(doc)
                setStatusError('')
                setStatusLoading(false)
                return doc
              })
              .catch(function (failure) {
                setStatusLoading(false)
                setStatusError(t('refreshFailed', { detail: messageOf(failure) }))
                logWarn('status failed', failure)
                return null
              })
          }

          /**
           * 目录缓存：点文件夹「慢」的主因是每次进出都重新拉一遍。
           * 命中缓存就**立刻**渲染，同时后台再拉一次校准（stale-while-revalidate）。
           * 写操作 / 手动刷新会清掉全部缓存。只缓存第一页（翻页数据不缓存）。
           */
          var listingCacheRef = React.useRef({})

          function cacheKeyOf(id, cursor) {
            return String(id || '/') + '|' + String(cursor || '')
          }

          /** 客户端目录缓存的有效期：比 Host 端（60s）宽松一点，因为这里只负责「秒开」。 */
          var LISTING_CACHE_TTL_MS = 5 * 60 * 1000

          function readListingCache(id, cursor) {
            if (cursor) return null // 只缓存首屏
            var bucket = listingCacheRef.current
            var hit = bucket[cacheKeyOf(id, cursor)]
            if (!hit) return null
            // 5 分钟内的缓存可以秒开；再久就别用了，数据可能变
            if (Date.now() - hit.at > LISTING_CACHE_TTL_MS) {
              delete bucket[cacheKeyOf(id, cursor)]
              return null
            }
            return hit.value
          }

          function writeListingCache(id, cursor, value) {
            if (cursor) return
            listingCacheRef.current[cacheKeyOf(id, cursor)] = { at: Date.now(), value: value }
          }

          function clearListingCache() {
            listingCacheRef.current = {}
          }

          function fetchListing(cursor, append) {
            var seq = seqRef.current + 1
            seqRef.current = seq
            var isFirstPage = !cursor
            var cached = isFirstPage ? readListingCache(parentId, '') : null

            // 命中缓存：先秒开，再后台校准。用户看到的就是「立刻响应」。
            if (isFirstPage) {
              if (cached) {
                setItems(cached.items)
                setNextCursor(cached.nextCursor || null)
                setListLoading(false)
                setListError('')
              } else {
                setListLoading(true)
                setListError('')
              }
            } else {
              setListLoading(true)
              setListError('')
            }

            return api.list(parentId, cursor || '')
              .then(function (doc) {
                if (seqRef.current !== seq) return
                var list = Array.isArray(doc.items) ? doc.items : []
                setItems(function (previous) { return append ? previous.concat(list) : list })
                setNextCursor(doc.nextCursor || null)
                setListLoading(false)
                if (isFirstPage) {
                  writeListingCache(parentId, '', { items: list, nextCursor: doc.nextCursor || null })
                }
              })
              .catch(function (failure) {
                if (seqRef.current !== seq) return
                setListLoading(false)
                // 有缓存就保持旧内容，只在上面挂一条轻提示，别把整页清空。
                if (cached && isFirstPage) {
                  setListError(t('refreshFailed', { detail: messageOf(failure) }))
                  return
                }
                setListError(t('listFailed', { detail: messageOf(failure) }))
                if (!append) {
                  setItems([])
                  setNextCursor(null)
                }
                logWarn('list failed', failure)
              })
          }

          /**
           * 滚到底部就接上下一批。
           *
           * 判断「到底」用的是「滚动位置 + 可视高度 >= 内容高度 - 阈值」，
           * 留 240px 提前量，滚动手感更连续（不会先看到空白再补上）。
           */
          function maybeLoadMore() {
            if (loadMoreBusyRef.current) return
            if (!nextCursor) return
            if (listLoading || busy) return
            if (searchOpen && searchKeyword.trim() !== '') return
            var el = listScrollRef.current
            if (!el) return
            var remaining = el.scrollHeight - el.scrollTop - el.clientHeight
            if (remaining > LOAD_MORE_THRESHOLD) return
            loadMoreBusyRef.current = true
            var cursor = nextCursor
            /** 兜底：万一 promise 链路没走完，40 秒后强制放行，别永久锁死。 */
            var releaseTimer = setTimeout(function () {
              loadMoreBusyRef.current = false
            }, 40000)
            fetchListing(cursor, true)
              .catch(function () {
                /* fetchListing 内部已经处理错误展示 */
              })
              .then(function () {
                clearTimeout(releaseTimer)
                loadMoreBusyRef.current = false
              })
          }

          /**
           * 内容不够一屏时自动接着拉。
           *
           * 场景：目录里只有 3 项，但还有下一批 —— 这时列表根本滚不动，
           * 用户看不到也滚不到底部，就永远触发不了 maybeLoadMore。
           * 所以每次列表变化后量一下：没填满就再要一批。
           *
           * 用 requestAnimationFrame 让浏览器先完成布局，量到的 scrollHeight 才是真的。
           */
          React.useEffect(function () {
            if (!nextCursor || listLoading) return
            var raf =
              typeof requestAnimationFrame === 'function'
                ? requestAnimationFrame
                : function (fn) { return setTimeout(fn, 16) }
            raf(function () {
              var el = listScrollRef.current
              if (!el) return
              if (listLoading || !nextCursor) return
              if (el.scrollHeight - el.clientHeight <= 4) maybeLoadMore()
            })
          }, [items, nextCursor, listLoading])

          function reload() {
            // 手动刷新：先清缓存，再强制拉一次            clearListingCache()
            return fetchListing('', false)
          }

          React.useEffect(function () {
            loadStatus()
          }, [])

          // 本机存过密码就预填账号 + 勾上「记住密码」；密码本身永远拿不回来（Host 也不回传）。
          // 只问一次；失败就当没存过，绝不影响登录页本身。
          React.useEffect(function () {
            if (loginSavedRef.current) return
            loginSavedRef.current = true
            api.loginSaved()
              .then(function (doc) {
                if (!doc || doc.hasSaved !== true) return
                var account = typeof doc.account === 'string' ? doc.account : ''
                if (account !== '') setLoginAccount(account)
                setRememberPassword(true)
                setSavedHint(t('loginSavedHint'))
              })
              .catch(function (failure) {
                logWarn('login/saved failed', failure)
              })
          }, [])

          React.useEffect(function () {
            if (!authorized) {
              seqRef.current += 1
              setItems([])
              setNextCursor(null)
              setListLoading(false)
              return
            }
            fetchListing('', false)
          }, [parentId, authorized])

          // ------------------------------------------------------ 传输 / 菜单副作用
          // interval 里调的是 ref，所以每次渲染后都把它指向最新一版 fetchTransfers。
          React.useEffect(function () {
            fetchRef.current = fetchTransfers
          })

          // 上传面板的目标目录同样过一遍 ref：投放回调里读得又稳又新。
          React.useEffect(function () {
            uploadTargetRef.current = uploadOpen ? uploadTarget : null
          }, [uploadOpen, uploadTarget])

          // 卸载时一定要停表：不在有任务时才轮询，也绝不漏一个野 interval / 定时器。
          React.useEffect(function () {
            return function () {
              stopTransferPolling()
              clearUrlTimers()
            }
          }, [])

          // 折叠区刚被「上传」菜单项展开：等它真挂上去了再聚焦 + 滚进来。
          React.useEffect(function () {
            if (!pathOpen || !focusUploadRef.current) return
            focusUploadRef.current = false
            focusUploadInput()
          }, [pathOpen])

          // 挂载（或重新授权）时先拉一次任务列表；有任务在跑它自己会开表。
          React.useEffect(function () {
            if (!authorized) {
              jobsRef.current = []
              setJobs([])
              stopTransferPolling()
              return
            }
            fetchTransfers()
          }, [authorized])

          // 下载目录：localStorage 优先，其次用 Host 给的默认值；用户改过就不再覆盖。
          React.useEffect(function () {
            if (downloadDirReadyRef.current || downloadDir !== '') return
            var stored = readDownloadDir()
            var fallback = status && typeof status.defaultDownloadDir === 'string' ? status.defaultDownloadDir : ''
            var initial = stored || fallback
            if (!initial) return
            downloadDirReadyRef.current = true
            setDownloadDir(initial)
          }, [status, downloadDir])

          // 显示名：只读一次本机存的值（拿不到就保持空 = 显示脱敏号码）。
          React.useEffect(function () {
            if (displayNameReadyRef.current) return
            displayNameReadyRef.current = true
            var stored = readDisplayName()
            if (stored !== '') setDisplayName(stored)
          }, [])

          // 菜单刚打开：量一次尺寸，会溢出视口就翻到光标左/上方。
          useLayout(function () {
            if (!menu || menu.placed) return
            var left = menu.x
            var top = menu.y
            var node = menuRef.current
            var rect = node && typeof node.getBoundingClientRect === 'function' ? node.getBoundingClientRect() : null
            if (rect) {
              var width = Number(rect.width) || 0
              var height = Number(rect.height) || 0
              var vw = typeof window !== 'undefined' ? Number(window.innerWidth) || 0 : 0
              var vh = typeof window !== 'undefined' ? Number(window.innerHeight) || 0 : 0
              if (vw > 0 && width > 0 && left + width > vw - 8) left = Math.max(8, menu.x - width)
              if (vh > 0 && height > 0 && top + height > vh - 8) top = Math.max(8, menu.y - height)
            }
            // placed 无论如何都要落下：量不到尺寸时也得把菜单亮出来，不能一直藏着。
            setMenu(function (previous) {
              if (!previous || previous.placed) return previous
              return { x: left, y: top, item: previous.item, placed: true }
            })
          }, [menu])

          // ------------------------------------------------------ 拖放护栏
          /**
           * 上传面板开着时，在 window 的**捕获阶段**接管面板内的拖放事件。
           *
           * 为什么非得在捕获阶段：DSH 的会话输入框也在监听拖放（丢文件进去会变成附件），
           * 而它很可能挂在 document 的捕获阶段 —— 那比我们面板里的冒泡处理更早。
           * 只有 window 捕获阶段能抢在它前面。
           *
           * 但这里**截断之后必须自己把事件转交给面板**，否则事件永远到不了拖拽区
           * （捕获阶段在 window 上 stopPropagation，目标元素就收不到了 ——
           *  上一版就是这么把上传搞坏的）。
           *
           * 所以：window 捕获 → 拦下 → 按事件类型调用面板对应的处理函数。
           */
          React.useEffect(function () {
            if (!uploadOpen) return undefined
            if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined

            function insidePanel(target) {
              try {
                var panelNode = dragGuardRef.current
                return Boolean(panelNode && target && typeof panelNode.contains === 'function' && panelNode.contains(target))
              } catch (failure) {
                return false
              }
            }

            function guard(event) {
              if (!insidePanel(event ? event.target : null)) return
              // 抢在宿主前面：既允许 drop，又阻止它继续被 document/window 上的监听拿走
              if (typeof event.preventDefault === 'function') event.preventDefault()
              if (typeof event.stopPropagation === 'function') event.stopPropagation()
              if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation()

              // 事件已经被我们截断，目标元素收不到了 —— 在这里手动转交给面板。
              var type = event ? event.type : ''
              try {
                if (type === 'dragenter') onDragEnter(event)
                else if (type === 'dragover') onDragOver(event)
                else if (type === 'dragleave') onDragLeave(event)
                else if (type === 'drop') onPanelDrop(event)
              } catch (failure) {
                logWarn('drag guard dispatch failed', failure)
              }
            }

            var EVENTS = ['dragenter', 'dragover', 'dragleave', 'drop']
            for (var i = 0; i < EVENTS.length; i += 1) {
              window.addEventListener(EVENTS[i], guard, true)
            }
            return function () {
              for (var j = 0; j < EVENTS.length; j += 1) {
                try {
                  window.removeEventListener(EVENTS[j], guard, true)
                } catch (failure) {
                  /* 卸不掉也无妨 */
                }
              }
            }
          }, [uploadOpen])


          React.useEffect(function () {
            if (!menu) return undefined
            function close() { setMenu(null) }
            function onPointer(event) {
              var node = menuRef.current
              var target = event ? event.target : null
              if (node && target && (node === target ||
                  (typeof node.contains === 'function' && node.contains(target)))) return
              close()
            }
            function onKey(event) {
              if (event && event.key === 'Escape') close()
            }
            if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
              document.addEventListener('mousedown', onPointer, true)
              document.addEventListener('contextmenu', onPointer, true)
              document.addEventListener('keydown', onKey, true)
            }
            if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
              window.addEventListener('scroll', close, true)
              window.addEventListener('resize', close, true)
              window.addEventListener('blur', close, true)
            }
            return function () {
              if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
                document.removeEventListener('mousedown', onPointer, true)
                document.removeEventListener('contextmenu', onPointer, true)
                document.removeEventListener('keydown', onKey, true)
              }
              if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
                window.removeEventListener('scroll', close, true)
                window.removeEventListener('resize', close, true)
                window.removeEventListener('blur', close, true)
              }
            }
          }, [menu])

          // 上传面板开着的时候：Escape 关掉它（面板和菜单不会同时开着）。
          React.useEffect(function () {
            if (!uploadOpen) return undefined
            function onKey(event) {
              if (event && event.key === 'Escape') closeUploadPanel()
            }
            if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
              document.addEventListener('keydown', onKey, true)
            }
            return function () {
              if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
                document.removeEventListener('keydown', onKey, true)
              }
            }
          }, [uploadOpen])

          // ------------------------------------------------------ 动作
          /** 成功就重拉列表 + 状态；失败只显示 banner，绝不往外抛。 */
          function runMutation(factory) {
            setBusy(true)
            setListError('')
            return factory()
              .then(function () {
                setBusy(false)
                loadStatus()
                // 增删改之后，「哪个文件夹还有下一级」的结论也可能变了 ——
                // 不清掉的话，删空的目录会一直挂着箭头。
                invalidateTreeKnowledge()
                return reload()
              })
              .catch(function (failure) {
                setBusy(false)
                setListError(t('actFailed', { detail: messageOf(failure) }))
                logWarn('mutation failed', failure)
                return null
              })
          }

          /**
           * 账号密码登录。
           *
           * 客户端先校验：账号或密码为空就**不发请求**（Host 那边也会拒，但没必要多跑一趟）。
           * 失败时账号必须留着 —— 用户重输密码就行，别逼他再打一遍手机号。
           * 成功时密码一律清空；只有没勾「记住密码」才连账号一起清掉（勾了的话
           * Host 已经把它存下来了，下次进来要预填）。
           */
          function submitLogin() {
            if (loginBusy) return
            var account = loginAccount.trim()
            var password = loginPassword
            if (!account || !password) {
              setLoginError(t('loginEmpty'))
              setLoginNotice('')
              return
            }
            var remember = rememberPassword === true
            setLoginBusy(true)
            setLoginError('')
            setLoginNotice('')
            api.login(account, password, remember)
              .then(function (doc) {
                setLoginBusy(false)
                setLoginPassword('')
                if (!remember) setLoginAccount('')
                setLoginNotice(t('loginOk') + (doc && doc.accountMasked ? ' · ' + doc.accountMasked : ''))
                if (remember) setSavedHint(t('loginSavedHint'))
                // /login 已经回传 accountMasked / quota：先乐观更新，不等第二次 /status。
                setStatus(function (previous) {
                  var base = previous && typeof previous === 'object' ? previous : {}
                  return {
                    ok: true,
                    authorized: true,
                    accountMasked: (doc && doc.accountMasked) || base.accountMasked || '',
                    expiresAt: typeof base.expiresAt === 'number' ? base.expiresAt : null,
                    credentialFileName: base.credentialFileName || '',
                    quota: (doc && doc.quota) || base.quota || null,
                    quotaError: (doc && doc.quotaError) || '',
                    host: base.host || null,
                    userDomainId: base.userDomainId || null,
                  }
                })
                setStack([])
                loadStatus().then(function () { reload() })
              })
              .catch(function (failure) {
                setLoginBusy(false)
                // 原样显示 Host 的 error（例如「账号或密码不正确」），不翻译、不改写。
                setLoginError(messageOf(failure))
                logWarn('login failed', failure)
              })
          }

          function saveAuth() {
            var authorization = authValue.trim()
            var userDomainId = udValue.trim()
            if (!authorization) {
              setAuthError(t('notAuthorized'))
              return
            }
            setAuthBusy(true)
            setAuthError('')
            setAuthNotice('')
            api.auth(authorization, userDomainId)
              .then(function (doc) {
                setAuthBusy(false)
                setAuthValue('')
                setReauthOpen(false)
                setAuthNotice(t('authOk') + (doc && doc.accountMasked ? ' · ' + doc.accountMasked : ''))
                // /auth 已经回传 accountMasked / quota：先乐观更新，不等第二次 /status。
                setStatus(function (previous) {
                  var base = previous && typeof previous === 'object' ? previous : {}
                  return {
                    ok: true,
                    authorized: true,
                    accountMasked: (doc && doc.accountMasked) || base.accountMasked || '',
                    expiresAt: typeof base.expiresAt === 'number' ? base.expiresAt : null,
                    credentialFileName: base.credentialFileName || '',
                    quota: (doc && doc.quota) || base.quota || null,
                    host: base.host || null,
                    userDomainId: userDomainId || base.userDomainId || null,
                  }
                })
                setStack([])
                loadStatus().then(function () { reload() })
              })
              .catch(function (failure) {
                setAuthBusy(false)
                setAuthError(messageOf(failure))
                logWarn('auth failed', failure)
              })
          }

          function clearAuth() {
            if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
              if (!window.confirm(t('clearConfirm'))) return
            }
            setAuthBusy(true)
            setAuthError('')
            api.clearAuth()
              .then(function () {
                setAuthBusy(false)
                setAuthNotice('')
                setReauthOpen(false)
                setAuthValue('')
                setUdValue('')
                setStack([])
                setItems([])
                setNextCursor(null)
                return loadStatus()
              })
              .catch(function (failure) {
                setAuthBusy(false)
                setAuthError(messageOf(failure))
                logWarn('clear auth failed', failure)
              })
          }

          function openReauth() {
            setReauthOpen(true)
            setAuthValue('')
            setUdValue((status && status.userDomainId) || '')
            setAuthError('')
            setAuthNotice('')
          }

          function enterFolder(item) {
            setStack(stack.concat([{ id: item.id, name: item.name }]))
          }

          function goCrumb(index) {
            setStack(stack.slice(0, index + 1))
          }

          function goRoot() {
            setStack([])
          }

          // ================================================================
          // 0.3.0 目录树
          // ================================================================

          /**
           * 🔴 网盘接口**不返回「这个文件夹有几个子项」**（folder 的 size 恒为 null，
           * 也没有 fileCount / childCount 之类字段，实测确认过）。
           *
           * 所以「有没有下级」只能问一次。这里做的是：
           *   · 展开父节点后，并发探测它的每个子文件夹（pageSize=1，最轻）；
           *   · 结果进内存缓存，同一次会话里不重复问；
           *   · 探测到「有」才给箭头 —— 所以永远不会出现「先有箭头、点一下没了」。
           */
          /**
           * 「这个文件夹有没有下级」的缓存。
           *
           * ⚠️ 必须有有效期：以前是永久缓存，结果用户把某个目录的子文件夹删光之后，
           * 箭头还一直挂着（缓存里还是「有」），看着像坏了。
           * 现在 45 秒过期，并且任何增删改都会整体作废（invalidateTreeKnowledge）。
           */
          var kidProbeCache = Object.create(null)
          /** 正在探测中的 folderId，避免同一目录被并发探测两次。 */
          var kidProbeInflight = Object.create(null)
          var KID_PROBE_TTL_MS = 45 * 1000

          /**
           * 把「树的结构知识」全部作废：探测缓存、展开状态、已加载的子节点。
           * 增删改、手动刷新之后都该调一次 —— 目录内容变了，树上的箭头和层级就得重算。
           *
           * 保留根节点展开（用户正看着它），只是让它重新拉一次子目录。
           */
          function invalidateTreeKnowledge() {
            kidProbeCache = Object.create(null)
            kidProbeInflight = Object.create(null)
            setTreeRoot({
              id: '/',
              name: '/',
              open: true,
              loading: false,
              loaded: false,
              children: [],
            })
          }

          /**
           * 拿「这个目录里有没有**子文件夹**」。
           *
           * 🔴 这里踩过坑：一开始判的是 `items.length > 0`（这个目录里有没有任何东西），
           * 结果「手机视频」这种只放了一堆视频文件、没有子文件夹的目录，
           * 也被判成「有下级」→ 树里挂了个箭头，但点开什么都没有。
           *
           * 正确判据是 **至少有一个 type === 'folder'**。
           * 麻烦在于列表按修改时间排序、文件和文件夹混在一起，
           * 第一页可能全是文件 —— 所以「这一页没有文件夹」还得往后翻几页确认，
           * 最多翻 3 页（30 项）；一旦翻到文件夹就立刻返回 true（大多数目录第一页就命中）。
           */
          function probeKid(folderId) {
            var cached = kidProbeCache[folderId]
            if (cached !== undefined && Date.now() - cached.at < KID_PROBE_TTL_MS) {
              return Promise.resolve(cached.has)
            }
            if (kidProbeInflight[folderId]) return kidProbeInflight[folderId]

            var MAX_PROBE_PAGES = 3
            function scan(cursor, page) {
              return api.list(folderId, cursor, 10).then(function (doc) {
                var items = doc && Array.isArray(doc.items) ? doc.items : []
                for (var i = 0; i < items.length; i += 1) {
                  if (items[i] && items[i].type === 'folder') return true
                }
                var next = doc && doc.nextCursor ? String(doc.nextCursor) : ''
                if (next && page < MAX_PROBE_PAGES) return scan(next, page + 1)
                // 翻完了都没有文件夹 → 确实没有下级
                return false
              })
            }

            var p = scan('', 1)
              .then(function (has) {
                kidProbeCache[folderId] = { has: has, at: Date.now() }
                delete kidProbeInflight[folderId]
                return has
              })
              .catch(function () {
                // 探测失败就先当作「未知」，不要缓存成 false（否则会永久少一个箭头）
                delete kidProbeInflight[folderId]
                return null
              })
            kidProbeInflight[folderId] = p
            return p
          }

          /**
           * 批量探测一组子文件夹，探到一个就更新一个。
           *
           * 全并发：树第一页最多 10 个文件夹，10 个请求同时发 ≈ 一次网络往返
           * （实测单次约 200ms，原来并发 4 要 480ms，现在一次就都回来了）。
           * 探到一个立刻更新一个，所以用户看到的是箭头「一个个跳出来」，
           * 不用等全部探完。
           */
          function probeTreeKids(parentId, folders) {
            var now = Date.now()
            var targets = folders.slice(0, 20).filter(function (folder) {
              if (!folder || !folder.id) return false
              var cached = kidProbeCache[folder.id]
              // 没探过、或者缓存过期了，都要重新探
              return cached === undefined || now - cached.at >= KID_PROBE_TTL_MS
            })
            if (!targets.length) return
            function applyOne(folderId, has) {
              if (has === null || has === undefined) return
              setTreeRoot(function (current) {
                return replaceTreeNode(current, parentId, function (node) {
                  var kids = node.children || []
                  var changed = false
                  var next = kids.map(function (kid) {
                    if (kid.id !== folderId) return kid
                    changed = true
                    return Object.assign({}, kid, { hasKids: has })
                  })
                  if (!changed) return node
                  return Object.assign({}, node, { children: next })
                })
              })
            }
            // 全部并发，不再排队
            var tasks = targets.map(function (folder) {
              return probeKid(folder.id).then(function (has) {
                applyOne(folder.id, has)
              })
            })
            Promise.all(tasks).catch(function () {
              /* 探测失败不影响树本身 */
            })
          }

          /**
           * 拖动「左树 / 右列表」中间那条分隔线来调宽度。
           *
           * 范围按用户要求卡死：
           *   · 最左：让左树刚好还能看清一级目录名（≈ 130px）；
           *   · 最右：不超过整个面板的一半 —— 再往右列表就没地方了。
           * 拖的时候给 body 加一个全局 cursor，避免鼠标移出分隔线后光标乱跳。
           */
          var TREE_MIN_WIDTH = 130

          function beginTreeResize(event) {
            // 只响应左键
            if (event.button !== undefined && event.button !== 0) return
            event.preventDefault()
            event.stopPropagation()
            var handle = event.currentTarget
            var treeEl = handle && handle.parentNode ? handle.parentNode.querySelector('.mc-exTree') : null
            var startX = event.clientX
            var startWidth = treeEl ? treeEl.getBoundingClientRect().width : 200
            setResizing(true)

            function maxWidth() {
              // 「页面中间」= 面板宽度的一半（面板宽度取 .mc-exBody 的宽度）
              var body = treeEl && treeEl.parentNode ? treeEl.parentNode : null
              var total = body ? body.getBoundingClientRect().width : (typeof window !== 'undefined' ? window.innerWidth : 1200)
              return Math.max(TREE_MIN_WIDTH + 40, Math.floor(total / 2))
            }

            function onMove(moveEvent) {
              // 拖动时吃掉默认行为：否则浏览器可能把它当文本选择/页面拖动
              if (typeof moveEvent.preventDefault === 'function') moveEvent.preventDefault()
              if (typeof moveEvent.stopPropagation === 'function') moveEvent.stopPropagation()
              var delta = moveEvent.clientX - startX
              var next = startWidth + delta
              var limit = maxWidth()
              if (next < TREE_MIN_WIDTH) next = TREE_MIN_WIDTH
              if (next > limit) next = limit
              setTreeWidth(Math.round(next))
            }

            function onUp() {
              setResizing(false)
              try {
                if (typeof document !== 'undefined') {
                  document.removeEventListener('mousemove', onMove, true)
                  document.removeEventListener('mouseup', onUp, true)
                  document.body.style.cursor = ''
                  document.body.style.userSelect = ''
                }
              } catch (failure) {
                /* 清理失败无所谓 */
              }
            }

            try {
              if (typeof document !== 'undefined') {
                document.addEventListener('mousemove', onMove, true)
                document.addEventListener('mouseup', onUp, true)
                document.body.style.cursor = 'col-resize'
                document.body.style.userSelect = 'none'
              }
            } catch (failure) {
              onUp()
            }
          }

          /** 双击分隔线 = 恢复自适应宽度。 */
          function resetTreeWidth() {
            setTreeWidth(null)
          }

          /** 在树里按 id 找节点，返回 { node, parentList, index }。 */          function findTreeNode(id, node, parentList, index) {
            node = node || treeRoot
            parentList = parentList || null
            index = index === undefined ? -1 : index
            if (node.id === id) return { node: node, parentList: parentList, index: index }
            var kids = node.children || []
            for (var i = 0; i < kids.length; i += 1) {
              var hit = findTreeNode(id, kids[i], kids, i)
              if (hit) return hit
            }
            return null
          }

          /** 不可变地替换树里某个节点（React 要新对象才会重渲染）。 */
          function replaceTreeNode(root, id, updater) {
            if (root.id === id) return updater(root)
            var kids = root.children || []
            var changed = false
            var nextKids = kids.map(function (kid) {
              var next = replaceTreeNode(kid, id, updater)
              if (next !== kid) changed = true
              return next
            })
            if (!changed) return root
            var copy = Object.assign({}, root)
            copy.children = nextKids
            return copy
          }

          /**
           * 加载某个树节点的子目录。
           *
           * 只取**文件夹**，文件不进树（资源管理器左树也不列文件）。
           * 一页 10 条的限制还在，这里循环翻页直到拿完 —— 树节点通常不多，
           * 但如果真遇到几百个子目录，最多翻 8 页就停，避免卡死。
           */
          /**
           * 加载某个树节点的子目录。
           *
           * ⚠️ 性能要点：**只取第一页**。
           * 以前是串行翻页最多 8 页，按实测 pageSize=10 一次约 1.3 秒算，
           * 一个放 30 个子文件夹的目录要翻 3 页 ≈ 4 秒 —— 点开树要等这么久，
           * 这就是「目录打开慢」的主要来源。
           *
           * 树只是导航，第一页（10 项）已经够用；真还有更多，末尾会多出一个
           * 「继续加载」的伪节点，用户点了再接下一页。右侧列表才是看全量的地方。
           */
          function loadTreeChildren(id, cursor) {
            var hit = findTreeNode(id)
            if (!hit || hit.node.loading) return
            var appending = !!cursor
            setTreeRoot(function (current) {
              return replaceTreeNode(current, id, function (node) {
                return Object.assign({}, node, { loading: true })
              })
            })
            api.list(id, cursor || '')
              .then(function (doc) {
                if (!doc || doc.ok === false) throw new Error((doc && doc.error) || 'load failed')
                var rows = Array.isArray(doc.items) ? doc.items : []
                var folders = rows.filter(function (row) {
                  return row.type === 'folder'
                })
                var more = doc.nextCursor ? String(doc.nextCursor) : ''
                // 空目录：把 open 收回 false，并且记下「确实没有下级」，
                // 这样用户点了一下之后箭头不会留着、也不会再显示。
                var isEmpty = folders.length === 0 && !more
                if (isEmpty) kidProbeCache[id] = { has: false, at: Date.now() }
                setTreeRoot(function (current) {
                  return replaceTreeNode(current, id, function (node) {
                    var previous = node.children || []
                    var mapped = folders.map(function (folder) {
                      // 已经展开过的节点保留展开状态与已缓存的子节点
                      var old = previous.filter(function (kid) {
                        return kid.id === folder.id
                      })[0]
                      return {
                        id: folder.id,
                        name: folder.name,
                        open: old ? old.open : false,
                        loading: false,
                        loaded: old ? old.loaded : false,
                        children: old ? old.children : [],
                        // 已知有没有子目录（探测后填），未知就是 null
                        hasKids: old ? old.hasKids : null,
                      }
                    })
                    var nextChildren = appending
                      ? previous.concat(mapped)
                      : mapped
                    return Object.assign({}, node, {
                      loading: false,
                      loaded: true,
                      // 空目录：子节点一并清空，别留着上次的
                      children: isEmpty ? [] : nextChildren,
                      // 空目录：收回展开态 + 明确标记没有下级
                      open: isEmpty ? false : node.open,
                      hasKids: isEmpty ? false : node.hasKids,
                    })
                  })
                })
                // 子列表到位后，顺手探测「哪些子目录还有下一级」，
                // 这样箭头从一开始就是准的，不会先显示再消失。
                if (!appending) probeTreeKids(id, folders)
              })
              .catch(function (failure) {
                logWarn('tree load failed', failure)
                setTreeRoot(function (current) {
                  return replaceTreeNode(current, id, function (node) {
                    return Object.assign({}, node, { loading: false })
                  })
                })
              })
          }

          /** 点树的箭头：展开 / 收起。第一次展开时去拉子目录。 */
          function toggleTreeNode(id) {
            var hit = findTreeNode(id)
            if (!hit) return
            var willOpen = !hit.node.open
            setTreeRoot(function (current) {
              return replaceTreeNode(current, id, function (node) {
                return Object.assign({}, node, { open: willOpen })
              })
            })
            if (willOpen && !hit.node.loaded) loadTreeChildren(id)
          }

          /**
           * 点树的名字：把右侧切到那个目录。
           *
           * 关键：右树的目录栈要和点击的节点对齐 ——
           * 这样面包屑、右键「上传到当前目录」、新建文件夹都落在对的地方。
           * 所以先把树上从根到该节点的名字路径算出来，再整体 setStack。
           */
          function selectTreeNode(id) {
            if (id === '/') {
              setStack([])
              setTreeFocusId('/')
              return
            }
            var path = []
            function walk(node, trail) {
              if (node.id === id) {
                path = trail.concat([{ id: node.id, name: node.name }])
                return true
              }
              var kids = node.children || []
              for (var i = 0; i < kids.length; i += 1) {
                if (walk(kids[i], trail.concat([{ id: node.id, name: node.name }]))) return true
              }
              return false
            }
            walk(treeRoot, [])
            // 去掉根（根是 "/"，栈里不存它）
            var next = path.filter(function (entry) {
              return entry.id !== '/'
            })
            setStack(next)
            setTreeFocusId(id)
            // 顺手复核一次「这目录还有没有下级」：
            // 用户可能刚在别处把它的子项删空/搬走，箭头得跟着变。
            recheckNodeHasKids(id)
          }

          /** 重新问一次某个节点「还有没有下级」，并更新树上的箭头。 */
          function recheckNodeHasKids(id) {
            if (!id || id === '/') return
            delete kidProbeCache[id]
            probeKid(id).then(function (has) {
              if (has === null || has === undefined) return
              setTreeRoot(function (current) {
                return replaceTreeNode(current, id, function (node) {
                  if (node.hasKids === has) return node
                  return Object.assign({}, node, { hasKids: has })
                })
              })
            })
          }

          /** 右侧切目录时，把左树同步展开到该目录（让高亮看得见）。 */
          function syncTreeToStack() {
            setTreeFocusId(parentId)
            if (parentId === '/') return
            // 从根开始逐级展开路径上的节点
            var trail = stack.map(function (entry) {
              return entry.id
            })
            function ensure(index) {
              if (index >= trail.length) return
              var id = trail[index]
              var hit = findTreeNode(id)
              if (!hit) return
              if (!hit.node.open) {
                setTreeRoot(function (current) {
                  return replaceTreeNode(current, id, function (node) {
                    return Object.assign({}, node, { open: true })
                  })
                })
              }
              if (!hit.node.loaded) loadTreeChildren(id)
              ensure(index + 1)
            }
            ensure(0)
          }

          // 目录一变就同步左树（第一层先展开，用户能看到自己点到了哪）
          React.useEffect(function () {
            if (!authorized) return
            syncTreeToStack()
            // 根节点第一次展开时把它的子目录拉出来
            if (!treeRoot.loaded && !treeRoot.loading) loadTreeChildren('/')
          }, [parentId, authorized])

          /**
           * 量出父容器的真实像素高度，写到根节点上。
           *
           * 为什么要这么干：`.mc-root-ide{height:100%}` 要求父元素有**确定高度**，
           * 而 DSH 的 view 容器不保证给。一旦失效，面板会被内容撑成一条长页面：
           *   · 列表内部的 overflow:auto 永远不触发（它没被压缩过）；
           *   · 底部进度条被推到内容最底下，得拖外层滚动条到底才看得到。
           * 这条现象和用户反馈完全一致，所以改用量出来的像素值。
           *
           * 同时用 ResizeObserver 跟随侧栏折叠、窗口缩放、对话区高度变化。
           */
          React.useEffect(function () {
            if (!authorized) return
            var el = ideRootRef.current
            if (!el || typeof window === 'undefined') return

            /**
             * 量高度要跨浏览器稳妥，所以按「由近到远」分四级兜底：
             *
             *   1. 直接父容器的 clientHeight（最准，含 padding 不含 border）
             *   2. 父容器的 getBoundingClientRect().height（clientHeight 报 0 时用，
             *      某些 WebView / 旧 Safari 上 clientHeight 会晚一拍才有值）
             *   3. 再往上一层的同样两种量法（父容器是 display:contents 或零高包裹时）
             *   4. 实在量不到：用视觉视口估（移动端地址栏收起/展开时
             *      innerHeight 会变，visualViewport.height 更贴近真实可视区）
             *
             * 高度只用来「撑满」，量小一点只是留白，量大才会出滚动条；
             * 所以宁可偏保守。
             */
            function readHeight(node) {
              if (!node) return 0
              var h = 0
              try {
                h = node.clientHeight || 0
              } catch (failure) {
                h = 0
              }
              if (h <= 0) {
                try {
                  var rect = node.getBoundingClientRect()
                  h = rect && rect.height ? Math.round(rect.height) : 0
                } catch (failure) {
                  h = 0
                }
              }
              return h > 0 ? h : 0
            }

            function viewportHint() {
              // 移动端地址栏会伸缩：visualViewport 比 innerHeight 准
              var vv = 0
              try {
                if (window.visualViewport && window.visualViewport.height) {
                  vv = Math.round(window.visualViewport.height)
                }
              } catch (failure) {
                vv = 0
              }
              if (vv <= 0) vv = Math.round(window.innerHeight || 0)
              if (vv <= 0) return 0
              // 面板在对话区里，大致占视口的 3/4；留一点余量避免顶出滚动条
              return Math.max(320, Math.floor(vv * 0.72))
            }

            function measure() {
              var node = ideRootRef.current
              if (!node) return
              var parent = node.parentElement
              var h = readHeight(parent)
              if (h <= 0 && parent) h = readHeight(parent.parentElement)
              if (h <= 0) h = viewportHint()
              if (h > 0) {
                setIdeHeight(function (previous) {
                  return previous === h ? previous : h
                })
              }
            }

            // 首帧 + 下一帧各量一次：有些浏览器首帧还没算完布局
            measure()
            var raf1 = 0
            var raf2 = 0
            if (typeof requestAnimationFrame === 'function') {
              raf1 = requestAnimationFrame(function () {
                measure()
                raf2 = requestAnimationFrame(measure)
              })
            }

            var observer = null
            try {
              if (typeof ResizeObserver === 'function' && el.parentElement) {
                observer = new ResizeObserver(measure)
                observer.observe(el.parentElement)
                // 父容器可能是零高包裹，再往上一层也盯一下
                if (el.parentElement.parentElement) observer.observe(el.parentElement.parentElement)
              }
            } catch (failure) {
              observer = null
            }

            window.addEventListener('resize', measure)
            window.addEventListener('orientationchange', measure)
            // 移动端软键盘 / 地址栏伸缩
            try {
              if (window.visualViewport && typeof window.visualViewport.addEventListener === 'function') {
                window.visualViewport.addEventListener('resize', measure)
                window.visualViewport.addEventListener('scroll', measure)
              }
            } catch (failure) {
              /* 没有 visualViewport */
            }

            // 窗口布局可能异步完成，补几次延迟测量
            var timers = [60, 200, 600, 1200, 2400].map(function (delay) {
              return setTimeout(measure, delay)
            })

            return function () {
              for (var i = 0; i < timers.length; i += 1) clearTimeout(timers[i])
              if (raf1 && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf1)
              if (raf2 && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf2)
              window.removeEventListener('resize', measure)
              window.removeEventListener('orientationchange', measure)
              try {
                if (window.visualViewport && typeof window.visualViewport.removeEventListener === 'function') {
                  window.visualViewport.removeEventListener('resize', measure)
                  window.visualViewport.removeEventListener('scroll', measure)
                }
              } catch (failure) {
                /* 没有 visualViewport */
              }
              if (observer) {
                try {
                  observer.disconnect()
                } catch (failure) {
                  /* 已经断开 */
                }
              }
            }
          }, [authorized])

          // ================================================================
          // 0.3.0 搜索
          // ================================================================
          function clearSearch() {
            searchSeqRef.current += 1
            setSearchKeyword('')
            setSearchItems([])
            setSearchNote('')
            setSearchError('')
            setSearchBusy(false)
            setSearchOpen(false)
          }

          /**
           * 执行搜索。带请求序号，快速输入时只认最后一次的结果。
           * 搜索范围：当前目录 + 若干层子目录（宿主端控制上限）。
           */
          function runSearch(keyword) {
            var needle = String(keyword === undefined ? searchKeyword : keyword).trim()
            if (!needle) {
              clearSearch()
              return
            }
            searchSeqRef.current += 1
            var seq = searchSeqRef.current
            setSearchBusy(true)
            setSearchError('')
            setSearchNote('')
            setSearchOpen(true)
            api
              .search({ keyword: needle, parentFileId: parentId })
              .then(function (doc) {
                if (seq !== searchSeqRef.current) return
                if (!doc || doc.ok === false) {
                  setSearchError((doc && doc.error) || t('actFailed', { detail: '' }))
                  setSearchItems([])
                  setSearchBusy(false)
                  return
                }
                var rows = Array.isArray(doc.items) ? doc.items : []
                setSearchItems(rows)
                setSearchBusy(false)
                if (rows.length === 0) {
                  setSearchNote(t('searchNoResult'))
                } else if (doc.truncated) {
                  setSearchNote(t('searchTruncated', { count: rows.length }))
                } else {
                  setSearchNote(t('searchCount', { count: rows.length }))
                }
              })
              .catch(function (failure) {
                if (seq !== searchSeqRef.current) return
                setSearchBusy(false)
                setSearchError(messageOf(failure))
                setSearchItems([])
              })
          }

          // 输入防抖：350ms 内不再输入就发请求
          React.useEffect(function () {
            if (!searchOpen) return
            var kw = searchKeyword.trim()
            if (!kw) {
              setSearchItems([])
              setSearchNote('')
              setSearchError('')
              return
            }
            var timer = setTimeout(function () {
              runSearch(kw)
            }, 350)
            return function () {
              clearTimeout(timer)
            }
          }, [searchKeyword])

          // ================================================================
          // 0.3.0 下载目录弹层
          // ================================================================
          function openDirModal() {
            setDirDraft(downloadDir)
            setDirError('')
            setDirPickBusy(false)
            setDirModal(true)
          }

          function closeDirModal() {
            setDirModal(false)
            setDirError('')
            setDirPickBusy(false)
          }

          /** 调宿主的系统「选择文件夹」对话框，选中后填进草稿。 */
          function pickDownloadDir() {
            if (dirPickBusy) return
            setDirPickBusy(true)
            setDirError('')
            api
              .pickDir()
              .then(function (doc) {
                setDirPickBusy(false)
                if (!doc || doc.ok === false) {
                  setDirError((doc && doc.error) || t('actFailed', { detail: '' }))
                  return
                }
                if (doc.cancelled) return
                if (doc.path) setDirDraft(String(doc.path))
              })
              .catch(function (failure) {
                setDirPickBusy(false)
                setDirError(messageOf(failure))
              })
          }

          function saveDownloadDir() {
            var next = dirDraft.trim()
            updateDownloadDir(next)
            setDirModal(false)
            setNotice(t('downloadDirSaved'))
            setTimeout(function () { setNotice('') }, 2200)
          }

          // ================================================================
          // 0.3.0 底部传输条：把 jobs 折算成一条整体进度
          // ================================================================
          /**
           * 进度条「至少亮这么久」。
           *
           * 小图片下载可能 50ms 就完事，如果严格按真实进度显示，
           * 进度条会闪一下就没 —— 用户根本看不到，以为没在传。
           * 所以强行让它至少亮 1.2 秒再进入完成态。
           */
          var TRANS_MIN_DRAW_MS = 1200
          /** 这一轮传输是什么时候开始的（0 = 当前没有在亮）。 */
          var transBeganAtRef = React.useRef(0)

          React.useEffect(function () {
            var list = Array.isArray(jobs) ? jobs : []
            // 和轮询用同一套「活跃」判断，别两处逻辑对不上
            var running = list.filter(isJobActive)
            var failed = list.filter(function (job) {
              return job && job.state === 'error'
            })
            function clearTimer() {
              if (transFadeRef.current !== null) {
                clearTimeout(transFadeRef.current)
                transFadeRef.current = null
              }
            }
            if (running.length > 0) {
              clearTimer()
              if (transBeganAtRef.current === 0) transBeganAtRef.current = Date.now()
              var total = 0
              var done = 0
              for (var i = 0; i < running.length; i += 1) {
                total += Math.max(0, Number(running[i].total) || 0)
                done += Math.max(0, Number(running[i].done) || 0)
              }
              setTransPercent(total > 0 ? Math.min(100, (done / total) * 100) : 0)
              setTransPhase('draw')
              return
            }
            // 没有运行中的任务：如果刚从「有任务」变成没有，就走
            // 「完成（停留 5 秒）→ 缓缓褪色 → 归位」。
            if (transPhase !== 'draw') return
            var hasError = failed.length > 0
            var began = transBeganAtRef.current
            var elapsed = began ? Date.now() - began : TRANS_MIN_DRAW_MS
            // 还没亮够时间就等一等，别让进度条闪一下就消失
            var wait = Math.max(0, TRANS_MIN_DRAW_MS - elapsed)
            clearTimer()
            transFadeRef.current = setTimeout(function () {
              transBeganAtRef.current = 0
              setTransPercent(100)
              setTransPhase(hasError ? 'error' : 'done')
              // 完成态停留 5 秒，再花 1.5 秒褪色
              transFadeRef.current = setTimeout(function () {
                setTransPhase('fade')
                transFadeRef.current = setTimeout(function () {
                  setTransPhase('idle')
                  setTransPercent(0)
                  transFadeRef.current = null
                }, 1600)
              }, 5000)
            }, wait)
          }, [jobs])

          // 卸载时清掉淡出定时器
          React.useEffect(function () {
            return function () {
              if (transFadeRef.current !== null) {
                clearTimeout(transFadeRef.current)
                transFadeRef.current = null
              }
            }
          }, [])

          function goUp() {
            setStack(stack.slice(0, stack.length - 1))
          }

          function createFolder() {
            var name = folderName.trim()
            if (!name) return
            runMutation(function () {
              return api.mkdir(parentId, name).then(function (doc) {
                setFolderName('')
                setFolderOpen(false)
                return doc
              })
            })
          }

          function renameEntry(item) {
            if (typeof window === 'undefined' || typeof window.prompt !== 'function') return
            var next = window.prompt(t('renamePrompt'), item.name)
            if (next === null) return
            next = String(next).trim()
            if (!next || next === item.name) return
            runMutation(function () {
              return api.rename(item.id, next)
            })
          }

          // ------------------------------------------------------ 复制路径
          /** 当前所在目录的完整路径，例如 "/windows/实验"。 */
          function currentDirPath() {
            return '/' + stack.map(function (s) { return s.name }).join('/')
          }

          /**
           * 把一个项的完整路径拼出来（基于当前目录栈 + 名字）。
           * 注意：这是**展示用的路径**，不是网盘的 fileId；移动云盘按 id 定位，
           * 所以这个路径只适合给人看 / 粘到笔记里。
           */
          function itemFullPath(item) {
            if (!item) return currentDirPath()
            var base = currentDirPath()
            return (base === '/' ? '' : base) + '/' + String(item.name || '')
          }

          /** 优先用剪贴板 API；不支持时退回 textarea + execCommand。 */
          function copyTextToClipboard(text) {
            return new Promise(function (resolve, reject) {
              if (typeof navigator !== 'undefined' && navigator.clipboard &&
                  typeof navigator.clipboard.writeText === 'function') {
                navigator.clipboard.writeText(text).then(resolve, function () {
                  // 权限被拒之类：退回老办法
                  fallbackCopy(text) ? resolve() : reject(new Error('clipboard unavailable'))
                })
                return
              }
              if (fallbackCopy(text)) { resolve(); return }
              reject(new Error('clipboard unavailable'))
            })
          }

          function fallbackCopy(text) {
            try {
              if (typeof document === 'undefined' || typeof document.createElement !== 'function') return false
              var area = document.createElement('textarea')
              area.value = text
              area.setAttribute('readonly', '')
              area.style.position = 'fixed'
              area.style.top = '-1000px'
              area.style.opacity = '0'
              var host = document.body || document.documentElement
              if (!host || typeof host.appendChild !== 'function') return false
              host.appendChild(area)
              area.select()
              if (typeof document.execCommand !== 'function') {
                host.removeChild(area)
                return false
              }
              var ok = document.execCommand('copy')
              host.removeChild(area)
              return ok === true
            } catch (failure) {
              logWarn('fallback copy failed', failure)
              return false
            }
          }

          function copyItemPath(item) {
            var path = itemFullPath(item)
            setNotice(t('pathCopied', { path: path }))
            copyTextToClipboard(path).then(function () {
              setNotice(t('pathCopied', { path: path }))
            }, function (failure) {
              // 复制失败也别让用户抓空：把路径显示出来让他自己选中
              setListError(t('copyFailed', { path: path }))
              logWarn('copy path failed', failure)
            })
          }

          function removeEntry(item) {
            if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
              if (!window.confirm(t('removeConfirm', { name: item.name }))) return
            }
            runMutation(function () {
              return api.remove([item.id])
            })
          }

          // ------------------------------------------------------ 转移（移动）到别的文件夹
          /**
           * 转移面板：打开时从根目录开始浏览，点文件夹进去，底部「转移到这里」。
           * 目标不能是被移动项自己，也不能是它自己内部的子目录（服务端会拒绝，
           * 但在这里先挡掉，省得用户白等一次往返）。
           */
          function openMovePicker(item) {
            if (!item) return
            setMoveSource(item)
            setMoveOpen(true)
            setMoveStack([])
            setMoveError('')
            setMoveNote('')
            setMoveLoading(true)
            api.list('/', '')
              .then(function (doc) {
                setMoveItems(Array.isArray(doc.items) ? doc.items : [])
                setMoveCursor(doc.nextCursor || null)
                setMoveLoading(false)
              })
              .catch(function (failure) {
                setMoveLoading(false)
                setMoveError(t('listFailed', { detail: messageOf(failure) }))
                logWarn('move picker list failed', failure)
              })
          }

          function closeMovePicker() {
            setMoveOpen(false)
            setMoveSource(null)
            setMoveStack([])
            setMoveItems([])
            setMoveCursor(null)
            setMoveError('')
            setMoveNote('')
          }

          function movePickerParentId() {
            return moveStack.length > 0 ? moveStack[moveStack.length - 1].id : '/'
          }

          function loadMoveDir(dirId) {
            setMoveLoading(true)
            setMoveError('')
            api.list(dirId, '')
              .then(function (doc) {
                setMoveItems(Array.isArray(doc.items) ? doc.items : [])
                setMoveCursor(doc.nextCursor || null)
                setMoveLoading(false)
              })
              .catch(function (failure) {
                setMoveLoading(false)
                setMoveError(t('listFailed', { detail: messageOf(failure) }))
                logWarn('move picker list failed', failure)
              })
          }

          function moveInto(folder) {
            setMoveStack(moveStack.concat([{ id: folder.id, name: folder.name }]))
            loadMoveDir(folder.id)
          }

          function moveUp() {
            var next = moveStack.slice(0, moveStack.length - 1)
            setMoveStack(next)
            loadMoveDir(next.length > 0 ? next[next.length - 1].id : '/')
          }

          /** 目标合法性：不能是它自己，也不能是它自己的子目录。 */
          function moveTargetProblem(targetId) {
            var source = moveSource
            if (!source) return 'no-source'
            if (String(source.id) === String(targetId)) return 'self'
            // 如果源是文件夹，且目标就在它当前所在的子路径上，服务端会拒绝
            for (var i = 0; i < moveStack.length; i += 1) {
              if (String(moveStack[i].id) === String(source.id)) return 'inside'
            }
            return null
          }

          function confirmMove() {
            var source = moveSource
            if (!source) return
            var targetId = movePickerParentId()
            var problem = moveTargetProblem(targetId)
            if (problem === 'self') { setMoveError(t('moveSelf')); return }
            if (problem === 'inside') { setMoveError(t('moveInside')); return }
            var targetName = moveStack.length > 0 ? moveStack[moveStack.length - 1].name : t('root')
            setMoveBusy(true)
            setMoveError('')
            api.move([source.id], targetId)
              .then(function () {
                setMoveBusy(false)
                closeMovePicker()
                // 移动后两边目录都变了：清缓存并刷新当前视图
                clearListingCache()
                return reload()
              })
              .catch(function (failure) {
                setMoveBusy(false)
                setMoveError(t('actFailed', { detail: messageOf(failure) }))
                logWarn('move failed', failure)
              })
          }

          function renderMovePicker() {
            if (!moveOpen || !moveSource) return null
            var targetName = moveStack.length > 0 ? moveStack[moveStack.length - 1].name : t('root')
            var folders = moveItems.filter(function (i) { return i.type === 'folder' })
            var overlay = h('div', {
              className: 'mc-overlay',
              onMouseDown: function (event) {
                if (event && event.target !== event.currentTarget) return
                closeMovePicker()
              },
            },
              h('div', { className: 'mc-panel', role: 'dialog', 'aria-modal': 'true' },
                h('div', { className: 'mc-panelHead' },
                  h('h2', { className: 'mc-panelTitle', title: t('moveTitle') }, t('moveTitle')),
                  h('button', {
                    type: 'button',
                    className: 'mc-btn mc-panelClose',
                    title: t('close'),
                    'aria-label': t('close'),
                    onClick: closeMovePicker,
                  }, '✕')
                ),
                h('p', { className: 'mc-hint' }, t('moveSource', { name: moveSource.name })),
                h('div', { className: 'mc-moveBar' },
                  moveStack.length > 0 ? h('button', {
                    className: 'mc-btn mc-btnSmall',
                    onClick: moveUp,
                  }, '↑ ' + t('up')) : null,
                  h('span', { className: 'mc-movePath', title: '/' + moveStack.map(function (s) { return s.name }).join('/') },
                    '/' + moveStack.map(function (s) { return s.name }).join('/'))
                ),
                moveError ? h('div', { className: 'mc-banner mc-bannerErr' }, moveError) : null,
                moveLoading
                  ? h('div', { className: 'mc-loading' }, t('loading'))
                  : (folders.length === 0
                    ? h('div', { className: 'mc-empty' }, t('moveNoFolders'))
                    : h('div', { className: 'mc-moveList' }, folders.map(function (folder) {
                      var isSource = String(folder.id) === String(moveSource.id)
                      return h('button', {
                        key: folder.id,
                        type: 'button',
                        className: 'mc-moveRow' + (isSource ? ' mc-moveRowDisabled' : ''),
                        disabled: isSource,
                        title: isSource ? t('moveInside') : folder.name,
                        onClick: function () { moveInto(folder) },
                      }, '📁 ' + folder.name, isSource ? h('span', { className: 'mc-moveTag' }, t('moveInside')) : null)
                    }))
                  ),
                h('div', { className: 'mc-panelFoot' },
                  h('button', {
                    className: 'mc-btn mc-btnPrimary',
                    disabled: moveBusy || moveLoading,
                    onClick: confirmMove,
                  }, moveBusy ? t('loading') : t('moveHere', { name: targetName })),
                  h('button', { className: 'mc-btn', onClick: closeMovePicker }, t('cancel'))
                )
              )
            )
            return portalToBody(overlay)
          }


          function openLink(item) {
            setLinkBusy(item.id)
            setListError('')
            api.link(item.id)
              .then(function (doc) {
                setLinkBusy('')
                if (doc && doc.url && typeof window !== 'undefined' && typeof window.open === 'function') {
                  window.open(doc.url, '_blank', 'noopener')
                  return
                }
                throw new Error(t('error'))
              })
              .catch(function (failure) {
                setLinkBusy('')
                setListError(t('openFailed', { detail: messageOf(failure) }))
                logWarn('link failed', failure)
              })
          }

          function onEnterKey(fn) {
            return function (event) {
              if (event.key === 'Enter') {
                event.preventDefault()
                fn()
              }
            }
          }

          // ------------------------------------------------------ 传输任务
          function stopTransferPolling() {
            if (pollTimerRef.current !== null) {
              try {
                clearInterval(pollTimerRef.current)
              } catch (failure) {
                logWarn('clear transfer timer failed', failure)
              }
              pollTimerRef.current = null
            }
            pollingRef.current = false
          }

          function applyJobs(list) {
            jobsRef.current = list
            setJobs(list)
          }

          /**
           * 这个任务是不是「还在动」。
           *
           * 🔴 这里踩过一个坑：一开始只认 state === 'running'，
           * 但任务刚建出来时是 queued / scan（甚至 pending），
           * 于是 startJob 之后第一次 fetchTransfers 判定「没有在跑的」→
           * 直接把轮询停了，进度条永远等不到更新，用户就「看不见进度条」。
           *
           * 所以凡是「还没结束」的状态都算活跃。终态只有 done / error / cancelled。
           */
          function isJobActive(job) {
            if (!job) return false
            var state = String(job.state || '')
            if (state === 'done' || state === 'error' || state === 'cancelled' || state === 'canceled') {
              return false
            }
            return true
          }

          function hasRunningJob(list) {
            for (var i = 0; i < list.length; i += 1) {
              if (isJobActive(list[i])) return true
            }
            return false
          }

          function ensureTransferPolling() {
            if (pollingRef.current) return
            pollingRef.current = true
            pollTimerRef.current = setInterval(function () {
              // 走 ref：轮询回调要用的永远是最新一版（parentId 可能已经变了）。
              if (typeof fetchRef.current === 'function') fetchRef.current()
            }, TRANSFER_POLL_MS)
          }

          function jobById(list, id) {
            for (var i = 0; i < list.length; i += 1) {
              if (list[i] && list[i].id === id) return list[i]
            }
            return null
          }

          /** 拉一次任务列表：有任务在跑就开表，没有就停表。失败不往外抛。 */
          function fetchTransfers() {
            return api.transfers()
              .then(function (doc) {
                var list = doc && Array.isArray(doc.jobs) ? doc.jobs : []
                var previous = jobsRef.current || []
                var uploadFinished = false
                for (var i = 0; i < list.length; i += 1) {
                  var job = list[i]
                  if (!job || job.kind !== 'upload' || job.state !== 'done') continue
                  var before = jobById(previous, job.id)
                  if (before && before.state === 'running') uploadFinished = true
                }
                applyJobs(list)
                if (hasRunningJob(list)) ensureTransferPolling()
                else stopTransferPolling()
                // 上传落地后当前目录里才会多出这个文件，刷新一次列表。
                if (uploadFinished) reload()
                return list
              })
              .catch(function (failure) {
                logWarn('transfers failed', failure)
                // 拉不到时：已知还有任务在跑就留着等重试，否则停表 —— 不留空转的 interval。
                if (!hasRunningJob(jobsRef.current || [])) stopTransferPolling()
                return []
              })
          }

          /**
           * 起一个任务。POST 只会回 jobId（连没授权也是先 200），
           * 所以这里只负责提示「已开始」，进度和真正的失败都在传输面板里说。
           */
          function startJob(key, startedNotice, factory) {
            setJobBusy(key)
            setListError('')
            setNotice('')
            /**
             * 乐观地把进度条点亮。
             *
             * 🔴 这里踩过坑：小图片下载可能 50ms 就完事，等 fetchTransfers
             * 回来时任务已经是 done —— 而进度条的状态机只在「当前是 draw」
             * 时才肯转 done，于是整条进度条从头到尾都没出现过，用户以为没在传。
             *
             * 所以起任务的动作本身就先把 transPhase 设成 'draw' 并记下开始时间，
             * 这样即使任务瞬间完成，也能走完「亮起 → 完成 → 停留 5 秒 → 褪色」。
             */
            transBeganAtRef.current = Date.now()
            setTransPercent(0)
            setTransPhase('draw')
            return factory()
              .then(function (doc) {
                setJobBusy('')
                setNotice(startedNotice)
                return fetchTransfers().then(function () { return doc })
              })
              .catch(function (failure) {
                setJobBusy('')
                setListError(t('actFailed', { detail: messageOf(failure) }))
                logWarn('transfer start failed', failure)
                // 任务没起来：把乐观点亮的进度条收回去
                transBeganAtRef.current = 0
                setTransPhase('idle')
                setTransPercent(0)
                return null
              })
          }

          function downloadFile(item) {
            var localPath = joinPath(downloadDir, item.name)
            return startJob(item.id, t('downloadStarted', { name: item.name }), function () {
              return api.download(item.id, localPath)
            })
          }

          function downloadFolder(item) {
            if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
              if (!window.confirm(t('confirmDownloadFolder', { name: item.name }))) return null
            }
            var localDir = joinPath(downloadDir, item.name)
            return startJob(item.id, t('downloadStarted', { name: item.name }), function () {
              return api.downloadFolder(item.id, localDir)
            })
          }

          function startUpload() {
            var localPath = uploadPath.trim()
            if (!localPath) return null
            return startJob('upload', t('uploadStarted', { name: baseName(localPath) }), function () {
              return api.upload(localPath, parentId).then(function (doc) {
                setUploadPath('')
                return doc
              })
            }).then(function (doc) {
              // 起完任务就重拉列表 + 传输面板（真正落地后轮询还会再刷一次）。
              return refreshAfterUpload().then(function () { return doc })
            })
          }

          function cancelJob(job) {
            if (!job || !job.id) return
            setCancelBusy(job.id)
            api.cancelTransfer(job.id)
              .then(function () {
                setCancelBusy('')
                setNotice(t('transferCanceled'))
                return fetchTransfers()
              })
              .catch(function (failure) {
                setCancelBusy('')
                setListError(t('actFailed', { detail: messageOf(failure) }))
                logWarn('cancel transfer failed', failure)
              })
          }

          function updateDownloadDir(value) {
            downloadDirReadyRef.current = true
            setDownloadDir(value)
            writeDownloadDir(value)
          }

          /** 真正把光标送进路径输入框（折叠区可能刚展开）。 */
          function focusUploadInput() {
            var probeNode = uploadInputRef.current
            var node = uploadInputRef.current
            if (!node) return
            try {
              if (typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'center' })
            } catch (failure) {
              logWarn('scroll upload into view failed', failure)
            }
            try {
              if (typeof node.focus === 'function') node.focus()
            } catch (failure) {
              logWarn('focus upload failed', failure)
            }
          }

          /**
           * 右键菜单里的「上传」：路径输入框现在是折叠起来的，先展开，
           * 等它真挂上去（pathOpen 的 effect）再聚焦 —— 收起状态下的 input 不存在，
           * 直接 focus 会静默失败。
           */
          function focusUpload() {
            if (pathOpen) {
              focusUploadInput()
              return
            }
            focusUploadRef.current = true
            setPathOpen(true)
          }

          /**
           * 上传的目标目录**永远是「当前打开的这个目录」**，不跟着右键的那一行走。
           * （用户明确要求：右键上传传到页面所在的位置，不是被右键的那个文件夹。）
           */
          function parentIdOf() {
            return parentId
          }

          /**
           * 浏览器原生文件选择器（<input type="file">）。
           *
           * 不再让 Host spawn 系统对话框：实测在 DSH 宿主里那段 PowerShell 会秒退，
           * 根本弹不出窗口，还带着 z-order / 抢焦点的问题。浏览器的 <input type="file">
           * 打开的本来就是系统的资源管理器对话框，字节也直接在浏览器里读、走 /upload-body。
           *
           * 取消时浏览器不发任何事件：window 重新获得焦点后若迟迟没有 change，就当取消清掉。
           * 万一连 focus 都收不到，超过 10 分钟也允许重新发起 —— UI 永远有退路，绝不永久锁死。
           */
          var pickStartedAtRef = React.useRef(0)
          var pickingRef = React.useRef(false)
          var pickerRef = React.useRef(null)
          var FOCUS_CANCEL_MS = 250
          var PICKER_STALE_MS = 10 * 60 * 1000

          /** 点下入口那一刻的目录钉死；不传 = 此刻打开的目录。 */
          function resolveTarget(targetParentId) {
            return targetParentId === null || targetParentId === undefined || targetParentId === ''
              ? parentId
              : targetParentId
          }

          /** 收掉还开着的选择器（卸载时也走这里，不留野监听 / 野节点）。 */
          function dropActivePicker() {
            var active = pickerRef.current
            if (!active) return
            pickerRef.current = null
            if (typeof active.cleanup === 'function') active.cleanup()
          }

          /**
           * 开一个隐藏的 <input type="file">，把用户选中的 File 列表交给 onPicked。
           * folder = true 时带 webkitdirectory（选文件夹，File 上会有 webkitRelativePath）。
           */
          function openFilePicker(folder, targetParentId, onPicked) {
            if (typeof document === 'undefined' || !document || typeof document.createElement !== 'function') return null
            if (pickingRef.current) {
              // 上一次选择器还开着：没过 10 分钟就别再开（防连点）；真卡住了就收掉重开。
              if (Date.now() - pickStartedAtRef.current < PICKER_STALE_MS) return null
              dropActivePicker()
            }
            var target = resolveTarget(targetParentId)
            var input = document.createElement('input')
            var settled = false
            var focusTimer = null

            function removeFocusListener() {
              if (typeof window === 'undefined' || typeof window.removeEventListener !== 'function') return
              try {
                window.removeEventListener('focus', onWindowFocus)
              } catch (failure) {
                logWarn('remove picker focus listener failed', failure)
              }
            }
            function removeChangeListener() {
              if (input && typeof input.removeEventListener === 'function') {
                try {
                  input.removeEventListener('change', onChange)
                } catch (failure) {
                  logWarn('remove picker change listener failed', failure)
                }
                return
              }
              if (input && input.onchange === onChange) input.onchange = null
            }
            function cleanup() {
              if (settled) return
              settled = true
              if (focusTimer !== null) {
                try {
                  clearTimeout(focusTimer)
                } catch (failure) {
                  logWarn('clear picker focus timer failed', failure)
                }
                focusTimer = null
              }
              removeFocusListener()
              removeChangeListener()
              try {
                if (input && input.parentNode && typeof input.parentNode.removeChild === 'function') {
                  input.parentNode.removeChild(input)
                }
              } catch (failure) {
                logWarn('remove picker input failed', failure)
              }
              if (pickerRef.current && pickerRef.current.cleanup === cleanup) pickerRef.current = null
              pickingRef.current = false
              setPicking(false)
            }
            function onWindowFocus() {
              if (settled || focusTimer !== null) return
              // 回到前台了：再给 change 一点时间（有的浏览器 focus 早于 change）。
              focusTimer = setTimeout(function () {
                focusTimer = null
                if (settled) return
                cleanup()
                setNotice(t('pickCancelled'))
              }, FOCUS_CANCEL_MS)
            }
            function onChange() {
              if (settled) return
              var files = []
              try {
                var list = input ? input.files : null
                if (list && typeof list.length === 'number') {
                  for (var i = 0; i < list.length; i += 1) {
                    if (list[i]) files.push(list[i])
                  }
                }
              } catch (failure) {
                logWarn('read picked files failed', failure)
              }
              // picking 立刻放掉：按钮马上就能再点。
              cleanup()
              setListError('')
              if (files.length === 0) {
                setNotice(t('noFilesSelected'))
                return
              }
              setNotice('')
              setDropNote('')
              try {
                var started = onPicked(files, target)
                if (started && typeof started.catch === 'function') {
                  started.catch(function (failure) {
                    logWarn('picked upload failed', failure)
                    return null
                  })
                }
              } catch (failure) {
                logWarn('picked upload failed', failure)
              }
            }

            try {
              input.type = 'file'
              input.multiple = true
              if (folder) input.webkitdirectory = true
              input.setAttribute('aria-hidden', 'true')
              input.tabIndex = -1
              if (input.style) input.style.display = 'none'
            } catch (failure) {
              logWarn('prepare picker input failed', failure)
            }
            if (input && typeof input.addEventListener === 'function') input.addEventListener('change', onChange)
            else if (input) input.onchange = onChange

            pickerRef.current = { cleanup: cleanup }

            try {
              var host = (typeof document.body !== 'undefined' && document.body) ||
                (typeof document.documentElement !== 'undefined' && document.documentElement) ||
                null
              if (host && typeof host.appendChild === 'function') host.appendChild(input)
            } catch (failure) {
              logWarn('attach picker input failed', failure)
            }
            if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
              window.addEventListener('focus', onWindowFocus)
            }

            // ⚠️ 顺序是关键：input.click() 必须**在**任何 setState 之前调用。
            // 浏览器的「用户手势」是有时效的，先 setState 会引发一次同步重渲染，
            // 把手势窗口耗掉，click() 就被静默拦截 —— 表现同样是「点了没反应」。
            // picking 相关状态用 ref 先记上就行，界面稍后自己会刷新。
            pickingRef.current = true
            pickStartedAtRef.current = Date.now()
            try {
              input.click()
            } catch (failure) {
              logWarn('open file picker failed', failure)
              cleanup()
              setListError(t('actFailed', { detail: messageOf(failure) }))
              return null
            }
            setPicking(true)
            setListError('')
            setNotice('')
            setDropNote('')
            return null
          }

          /** 「上传文件」：开原生多选，选完逐个传到 targetParentId。 */
          function pickFiles(targetParentId) {
            return openFilePicker(false, targetParentId, function (files, target) {
              return uploadPickedFiles(files, target)
            })
          }

          /** 「上传文件夹」：webkitdirectory 多选，先按相对路径建目录再逐个上传。 */
          function pickFolder(targetParentId) {
            return openFilePicker(true, targetParentId, function (files, target) {
              return uploadPickedFolder(files, target)
            })
          }

          /** 逐个上传（串行）：复用拖拽那条进度行 + XHR。 */
          function uploadPickedFiles(files, targetParentId) {
            var chain = Promise.resolve()
            files.forEach(function (file) {
              chain = chain.then(function () { return uploadDroppedFile(file, targetParentId) })
            })
            return chain
          }

          /** webkitRelativePath 'F/sub/b.txt' → 'F/sub'；没有斜杠 = 当前目录。 */
          function relativeDirOf(file) {
            var rel = file && typeof file.webkitRelativePath === 'string' ? file.webkitRelativePath : ''
            var text = rel.replace(/\\/g, '/')
            var cut = text.lastIndexOf('/')
            return cut > 0 ? text.slice(0, cut) : ''
          }

          /** 选中的那个文件夹叫什么（webkitRelativePath 的第一段）。 */
          function pickedFolderName(files) {
            for (var i = 0; i < files.length; i += 1) {
              var rel = files[i] && typeof files[i].webkitRelativePath === 'string'
                ? files[i].webkitRelativePath.replace(/\\/g, '/')
                : ''
              if (rel) return rel.split('/')[0]
            }
            return t('upload')
          }

          /**
           * 「上传文件夹」：webkitRelativePath 带着层级，先把远端目录按「父先子后」建出来
           * （每个目录只建一次；Host 的 /mkdir-path 会复用已存在的同名目录），
           * 再把每个文件塞进它自己那一层。
           */
          function uploadPickedFolder(files, targetParentId) {
            var folderName = pickedFolderName(files)
            setNotice(t('uploadFolderStarted', { name: folderName }))
            var dirs = []
            var seen = {}
            files.forEach(function (file) {
              var dir = relativeDirOf(file)
              if (!seen[dir]) {
                seen[dir] = true
                dirs.push(dir)
              }
            })
            // 前缀一定排在扩展之前（'F' < 'F/sub'）；再按层数兜一次：父目录先建。
            dirs.sort(function (a, b) {
              var depthA = a ? a.split('/').length : 0
              var depthB = b ? b.split('/').length : 0
              if (depthA !== depthB) return depthA - depthB
              return a < b ? -1 : (a > b ? 1 : 0)
            })
            var dirIds = { '': targetParentId }
            var chain = Promise.resolve()
            dirs.forEach(function (dir) {
              if (dir === '') return
              chain = chain.then(function () {
                return api.mkdirPath(targetParentId, dir).then(function (doc) {
                  var id = doc && doc.fileId !== undefined && doc.fileId !== null ? doc.fileId : null
                  if (id === null) throw new Error('mkdir-path 没有返回 fileId')
                  dirIds[dir] = id
                })
              })
            })
            chain = chain.then(function () {
              var uploads = Promise.resolve()
              files.forEach(function (file) {
                var dir = relativeDirOf(file)
                var parent = dirIds[dir] === undefined ? targetParentId : dirIds[dir]
                uploads = uploads.then(function () { return uploadDroppedFile(file, parent) })
              })
              return uploads
            })
            return chain
              .then(function () {
                setNotice(t('uploadFolderDone', { name: folderName, count: files.length }))
                return refreshAfterUpload()
              })
              .catch(function (failure) {
                setListError(t('uploadFolderFailed', { detail: messageOf(failure) }))
                logWarn('folder upload failed', failure)
                return null
              })
          }

          // ------------------------------------------------------ 上传面板
          /** 打开面板：目标在「点下菜单项/按钮」这一刻钉住，之后翻目录也不改。 */
          function openUploadPanel() {
            setUploadTarget({ id: parentId, name: '' })
            setDropNote('')
            setDragOver(false)
            dragDepthRef.current = 0
            setUploadOpen(true)
          }

          function closeUploadPanel() {
            setUploadOpen(false)
            setUploadTarget(null)
            setDragOver(false)
            dragDepthRef.current = 0
          }

          /** 起完上传就重拉列表 + 任务面板：新任务要出现在传输面板里。 */
          function refreshAfterUpload() {
            return fetchTransfers()
              .then(function () { return reload() })
              .catch(function (failure) {
                logWarn('refresh after upload failed', failure)
                return null
              })
          }

          /** 拖进来的「文件夹占位」长这样：没有大小、没有 MIME、名字里连点都没有。 */
          function looksLikeFolder(file) {
            if (!file) return false
            if (Number(file.size) !== 0) return false
            if (file.type) return false
            var name = typeof file.name === 'string' ? file.name : ''
            return name !== '' && name.indexOf('.') < 0
          }

          /**
           * 从 dataTransfer 里挑出能上传的文件；文件夹一律礼貌拒绝。
           * 优先用 webkitGetAsEntry()（只有它认得出「拖进来的目录」），
           * 拿不到就退到「空文件 + 无 MIME + 名字没点」这个土办法。
           */
          function collectDroppedFiles(dataTransfer) {
            var files = []
            var refusedFolder = false
            var items = dataTransfer && dataTransfer.items ? dataTransfer.items : null
            if (items && items.length) {
              for (var i = 0; i < items.length; i += 1) {
                var item = items[i]
                if (!item || (item.kind && item.kind !== 'file')) continue
                var entry = null
                if (typeof item.webkitGetAsEntry === 'function') {
                  try {
                    entry = item.webkitGetAsEntry()
                  } catch (failure) {
                    entry = null
                  }
                }
                if (entry && entry.isDirectory) {
                  refusedFolder = true
                  continue
                }
                var file = typeof item.getAsFile === 'function' ? item.getAsFile() : null
                if (!file) continue
                if (looksLikeFolder(file)) {
                  refusedFolder = true
                  continue
                }
                files.push(file)
              }
            }
            // items 不存在（或一个文件都没挑出来）时退回 files 列表。
            if (files.length === 0 && dataTransfer && dataTransfer.files && dataTransfer.files.length) {
              for (var j = 0; j < dataTransfer.files.length; j += 1) {
                var plain = dataTransfer.files[j]
                if (!plain) continue
                if (looksLikeFolder(plain)) {
                  refusedFolder = true
                  continue
                }
                files.push(plain)
              }
            }
            return { files: files, refusedFolder: refusedFolder }
          }

          function pushUrlItem(entry) {
            setUrlItems(function (previous) {
              var next = previous.concat([entry])
              return next.length > URL_LINE_VISIBLE ? next.slice(next.length - URL_LINE_VISIBLE) : next
            })
          }

          function updateUrlItem(id, patch) {
            setUrlItems(function (previous) {
              return previous.map(function (entry) {
                if (!entry || entry.id !== id) return entry
                var next = { id: entry.id, name: entry.name, percent: entry.percent, state: entry.state }
                if (patch.percent !== undefined) next.percent = patch.percent
                if (patch.state !== undefined) next.state = patch.state
                return next
              })
            })
          }

          /** 进度行别当场消失：留几秒让用户看到「完成 / 失败」。 */
          function scheduleUrlItemDrop(id) {
            try {
              var timer = setTimeout(function () {
                setUrlItems(function (previous) {
                  return previous.filter(function (entry) { return !entry || entry.id !== id })
                })
              }, URL_LINE_LINGER_MS)
              urlTimersRef.current.push(timer)
            } catch (failure) {
              logWarn('schedule url line removal failed', failure)
            }
          }

          function clearUrlTimers() {
            var timers = urlTimersRef.current || []
            for (var i = 0; i < timers.length; i += 1) {
              try {
                clearTimeout(timers[i])
              } catch (failure) {
                logWarn('clear url line timer failed', failure)
              }
            }
            urlTimersRef.current = []
          }

          /**
           * 一个文件的拖拽上传：进度行 + XHR（上行进度只有 XHR 给得了）。
           * 失败走文件区那条错误 banner，任务本身的成败仍然看传输面板。
           */
          function uploadDroppedFile(file, targetParentId) {
            var id = urlSeqRef.current + 1
            urlSeqRef.current = id
            var name = file && file.name ? String(file.name) : 'upload.bin'
            pushUrlItem({ id: id, name: name, percent: 0, state: 'uploading' })
            setJobBusy('drop')
            return api.uploadBody(file, targetParentId, function (percent) {
              updateUrlItem(id, { percent: percent })
            })
              .then(function () {
                setJobBusy('')
                updateUrlItem(id, { percent: 100, state: 'done' })
                setNotice(t('urlUploadDone', { name: name }))
                scheduleUrlItemDrop(id)
                return refreshAfterUpload()
              })
              .catch(function (failure) {
                setJobBusy('')
                updateUrlItem(id, { state: 'error' })
                setListError(t('urlUploadFailed', { detail: messageOf(failure) }))
                logWarn('drop upload failed', failure)
                return null
              })
          }

          /**
           * 拖拽投放。HTML 默认不允许 drop：onDragOver/onDrop 都必须 preventDefault，
           * 否则浏览器只会「打开」那个文件，永远到不了这里。
           *
           * ⚠️ 还要 stopPropagation：DSH 的会话输入框也监听拖放，
           * 不拦住的话文件会同时被它接走（一边上传、一边在会话里生成附件）。
           * 注意**不要**用 stopImmediatePropagation —— 那是「同一元素上的其他监听也别跑」，
           * 在某些实现里会连自己的后续处理一起掐掉。stopPropagation 足够：
           * 事件已经到达我们的目标节点，阻止它继续往外冒就行。
           */
          function stopDragEvent(event) {
            if (!event) return
            if (typeof event.preventDefault === 'function') event.preventDefault()
            if (typeof event.stopPropagation === 'function') event.stopPropagation()
          }

          function onDrop(event) {
            stopDragEvent(event)
            return handleDrop(event)
          }

          /** 面板里的拖拽区：投到打开面板时钉住的那个目录（不是此刻浏览的目录）。 */
          function onPanelDrop(event) {
            stopDragEvent(event)
            var frozen = uploadTargetRef.current
            return handleDrop(event, frozen && frozen.id !== undefined && frozen.id !== null ? frozen.id : parentId)
          }

          /** 拖进来的文件按顺序一个一个传（不并发，进度条也看得清）。 */
          function handleDrop(event, targetOverride) {
            dragDepthRef.current = 0
            setDragOver(false)
            var dataTransfer = event && event.dataTransfer ? event.dataTransfer : null
            var picked = collectDroppedFiles(dataTransfer)
            setDropNote(picked.refusedFolder ? t('dropFolderHint') : '')
            if (picked.files.length === 0) return null
            var targetParentId = targetOverride === null || targetOverride === undefined || targetOverride === ''
              ? parentId
              : targetOverride
            var chain = Promise.resolve()
            picked.files.forEach(function (file) {
              chain = chain.then(function () { return uploadDroppedFile(file, targetParentId) })
            })
            return chain
          }

          function onDragEnter(event) {
            stopDragEvent(event)
            dragDepthRef.current += 1
            setDragOver(true)
          }

          // HTML 默认不让 drop：不 preventDefault 就永远收不到。
          function onDragOver(event) {
            stopDragEvent(event)
            if (event && event.dataTransfer) {
              try {
                event.dataTransfer.dropEffect = 'copy'
              } catch (failure) {
                logWarn('set dropEffect failed', failure)
              }
            }
            if (!dragOver) setDragOver(true)
          }

          function onDragLeave(event) {
            stopDragEvent(event)
            dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
            if (dragDepthRef.current === 0) setDragOver(false)
          }

          // ------------------------------------------------------ 右键菜单
          /** 在光标处开菜单；item 为空 = 列表空白处那一套。 */
          function openMenu(event, item) {
            if (event) {
              if (typeof event.preventDefault === 'function') event.preventDefault()
              if (typeof event.stopPropagation === 'function') event.stopPropagation()
            }
            var x = event ? Number(event.clientX) || 0 : 0
            var y = event ? Number(event.clientY) || 0 : 0
            // 键盘呼出（Shift+F10 / 菜单键）没有坐标：退到这一行的左下角。
            if (event && x === 0 && y === 0 && event.currentTarget &&
                typeof event.currentTarget.getBoundingClientRect === 'function') {
              var rect = event.currentTarget.getBoundingClientRect()
              x = Math.round(Number(rect.left) || 0) + 12
              y = Math.round(Number(rect.bottom) || 0)
            }
            setMenu({ x: x, y: y, item: item || null, placed: false })
          }

          function closeMenu() {
            setMenu(null)
          }

          function menuItem(key, label, run, extraClass) {
            // 用 onMouseDown 而不是 onClick：
            // 菜单外面的「点别处就关」监听挂在 document 的 mousedown 捕获阶段。
            // 如果只监听 click，按下鼠标的那一刻菜单就被卸载了，click 永远到不了按钮 ——
            // 表现就是「点菜单项完全没反应」。面板里的按钮没有这个机制，所以一直正常。
            var fired = false
            function trigger(event) {
              if (event && typeof event.preventDefault === 'function') event.preventDefault()
              if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
              if (fired) return
              fired = true
              closeMenu()
              try {
                run()
              } catch (failure) {
                logWarn('menu item failed', failure)
              }
            }
            return h('button', {
              key: key,
              type: 'button',
              role: 'menuitem',
              className: 'mc-menuItem' + (extraClass ? ' ' + extraClass : ''),
              onMouseDown: trigger,
              // 键盘可达：回车/空格走 click，但 mousedown 已经处理过就不重复触发。
              onClick: function (event) {
                if (fired) return
                trigger(event)
              },
              onKeyDown: function (event) {
                if (event && (event.key === 'Enter' || event.key === ' ')) trigger(event)
              },
            }, label)
          }

          /**
           * 菜单上的三个上传入口：目标在点下去这一刻定下来（文件夹行 = 进这个文件夹，
           * 文件行/空白处 = 此刻打开的这个目录）。之后用户翻目录也不改。
           */
          function pushUploadItems(items, item) {
            // 上传目标永远是「当前打开的这个目录」，与右键在哪一行无关。
            // 注意：这里必须调 pickFiles / pickFolder（浏览器的原生 <input type="file">），
            // 不能再调已经删掉的 runPick —— 那会抛 ReferenceError，
            // 在 React 事件处理器里抛出来就是「点了完全没反应」。
            items.push(menuItem('upload-file', t('menuUploadFile'), function () {
              pickFiles(parentId)
            }))
            items.push(menuItem('upload-folder', t('menuUploadFolder'), function () {
              pickFolder(parentId)
            }))
            items.push(menuItem('drag-upload', t('menuDragUpload'), function () {
              openUploadPanel()
            }))
          }

          function renderMenu() {
            if (!menu) return null
            var items = []
            if (menu.item) {
              var item = menu.item
              if (item.type === 'folder') {
                // 文件夹右键只留这两项（用户要求）：
                // 进入文件夹靠点名字/双击，增删改移走其他入口。
                items.push(menuItem('copy-path', t('menuCopyPath'), function () { copyItemPath(item) }))
                items.push(menuItem('rename', t('menuRename'), function () { renameEntry(item) }))
              } else {
                items.push(menuItem('link', t('menuDownloadLink'), function () { openLink(item) }))
                items.push(menuItem('download', t('menuDownloadLocal'), function () { downloadFile(item) }))
                items.push(h('hr', { key: 'menu-sep-upload', className: 'mc-menuSep' }))
                pushUploadItems(items, item)
                items.push(h('hr', { key: 'menu-sep', className: 'mc-menuSep' }))
                items.push(menuItem('move', t('menuMove'), function () { openMovePicker(item) }))
                items.push(menuItem('copy-path', t('menuCopyPath'), function () { copyItemPath(item) }))
                items.push(menuItem('rename', t('menuRename'), function () { renameEntry(item) }))
                items.push(menuItem('remove', t('menuRemove'), function () { removeEntry(item) }, 'mc-menuItemDanger'))
              }
            } else {
              items.push(menuItem('new-folder', t('menuNewFolder'), function () {
                setFolderOpen(true)
                setFolderName('')
              }))
              items.push(menuItem('refresh', t('menuRefresh'), function () { reload() }))
              items.push(menuItem('copy-dir-path', t('menuCopyPath'), function () { copyItemPath(null) }))
              items.push(h('hr', { key: 'menu-sep-upload', className: 'mc-menuSep' }))
              pushUploadItems(items, null)
            }
            return h('div', {
              className: 'mc-menu',
              role: 'menu',
              ref: menuRef,
              style: {
                left: menu.x + 'px',
                top: menu.y + 'px',
                visibility: menu.placed ? 'visible' : 'hidden',
              },
              onContextMenu: function (event) {
                if (event && typeof event.preventDefault === 'function') event.preventDefault()
              },
            },
              menu.item ? h('div', {
                key: 'menu-head',
                className: 'mc-menuHead',
                title: menu.item.name,
              }, (menu.item.type === 'folder' ? '📁 ' : '📄 ') + menu.item.name) : null,
              items
            )
          }

          // ------------------------------------------------------ 授权卡
          /** 标签栏：账号密码 / 手动授权。当前那个有下划线 + 加粗。 */
          function renderAuthTabs() {
            function tab(key, id, label) {
              var active = authTab === id
              return h('button', {
                key: key,
                type: 'button',
                role: 'tab',
                'aria-selected': active ? 'true' : 'false',
                className: 'mc-tab' + (active ? ' mc-tabActive' : ''),
                onClick: function () {
                  if (authTab === id) return
                  setAuthTab(id)
                  // 切标签时把另一边的提示清掉，免得旧错误挂在新表单上。
                  setLoginError('')
                  setLoginNotice('')
                  setAuthError('')
                  setAuthNotice('')
                },
              }, label)
            }
            return h('div', { className: 'mc-tabs', role: 'tablist' },
              tab('tab-scan', 'scan', t('tabScan')),
              tab('tab-login', 'login', t('tabLogin'))
            )
          }

          /**
           * 扫码登录面板。
           *
           * 流程：点「开始扫码」→ 宿主拉起一个独立 Edge → 你在里面扫码 →
           * 宿主抓 cookie 里的 authorization → 这里轮询到 done → 刷新整页。
           *
           * 关键卖点：抓到的令牌能自动续期，所以**扫这一次就不用再扫了**。
           */
          function renderScanForm() {
            var st = scanState || {}
            var running = st.state === 'running' || st.phase === 'launching' || st.phase === 'waiting'
            var phaseText = ''
            if (st.state === 'launching' || st.phase === 'launching') phaseText = t('scanLaunching')
            else if (st.state === 'running' || st.phase === 'waiting') phaseText = st.message || t('scanWaiting')
            else if (st.state === 'done') phaseText = t('scanDone')
            else if (st.state === 'cancelled') phaseText = t('scanCancelled')
            else if (st.state === 'error') phaseText = st.message || t('scanFailed')

            return h('div', { className: 'mc-tabPanel', key: 'scanForm', role: 'tabpanel' },
              h('p', { className: 'mc-hint' }, t('scanIntro')),

              running
                ? h('div', { className: 'mc-scanBox' },
                  h('div', { className: 'mc-scanSpinner' }, '⟳'),
                  h('div', { className: 'mc-scanText' }, phaseText),
                  h('p', { className: 'mc-hint' }, t('scanBrowserHint')),
                  h('div', { className: 'mc-cardActions' },
                    h('button', {
                      className: 'mc-btn',
                      onClick: cancelScan,
                    }, t('cancel'))
                  )
                )
                : h('div', { className: 'mc-cardActions' },
                  h('button', {
                    className: 'mc-btn mc-btnPrimary',
                    onClick: beginScan,
                  }, st.state === 'error' || st.state === 'cancelled' ? t('scanRetry') : t('scanStart'))
                ),

              st.state === 'done' ? h('div', { className: 'mc-banner mc-bannerOk' }, t('scanDoneHint')) : null,
              st.state === 'error' ? h('div', { className: 'mc-banner mc-bannerErr' }, st.message || t('scanFailed')) : null,
              loginError ? h('div', { className: 'mc-banner mc-bannerErr' }, loginError) : null,

              h('p', { className: 'mc-securityNote' }, t('scanSecurityNote'))
            )
          }

          /** 账号密码登录表单。 */
          function renderLoginForm() {
            return h('div', { className: 'mc-tabPanel', key: 'loginForm', role: 'tabpanel' },
              h('div', { className: 'mc-field' },
                h('label', { className: 'mc-label' }, t('loginAccount')),
                h('input', {
                  className: 'mc-input',
                  type: 'text',
                  name: 'mc-login-account',
                  autoComplete: 'username',
                  spellCheck: false,
                  value: loginAccount,
                  placeholder: t('loginAccountPlaceholder'),
                  onChange: function (event) { setLoginAccount(event.target.value) },
                  onKeyDown: onEnterKey(submitLogin),
                })
              ),
              h('div', { className: 'mc-field' },
                h('label', { className: 'mc-label' }, t('loginPassword')),
                h('div', { className: 'mc-pwWrap' },
                  h('input', {
                    className: 'mc-input',
                    // 👁 只切 type，值不动。
                    type: showPassword ? 'text' : 'password',
                    name: 'mc-login-password',
                    autoComplete: 'current-password',
                    spellCheck: false,
                    value: loginPassword,
                    placeholder: t('loginPasswordPlaceholder'),
                    onChange: function (event) { setLoginPassword(event.target.value) },
                    onKeyDown: onEnterKey(submitLogin),
                  }),
                  h('button', {
                    key: 'pw-toggle',
                    type: 'button',
                    className: 'mc-pwToggle',
                    title: showPassword ? t('hidePassword') : t('showPassword'),
                    'aria-label': showPassword ? t('hidePassword') : t('showPassword'),
                    'aria-pressed': showPassword ? 'true' : 'false',
                    onClick: function () { setShowPassword(function (previous) { return !previous }) },
                  }, showPassword ? '🙈' : '👁')
                )
              ),
              h('label', { className: 'mc-checkRow' },
                h('input', {
                  type: 'checkbox',
                  checked: rememberPassword === true,
                  onChange: function (event) { setRememberPassword(event.target.checked === true) },
                }),
                h('span', { className: 'mc-checkText' }, t('rememberPassword'))
              ),
              h('p', { className: 'mc-formNote' }, t('rememberPasswordHint')),
              savedHint ? h('div', { className: 'mc-banner mc-bannerOk' }, savedHint) : null,
              loginError ? h('div', { className: 'mc-banner mc-bannerErr' }, loginError) : null,
              loginNotice ? h('div', { className: 'mc-banner mc-bannerOk' }, loginNotice) : null,
              h('div', { className: 'mc-submitRow' },
                h('button', {
                  className: 'mc-btn mc-btnPrimary mc-submit',
                  type: 'button',
                  disabled: loginBusy,
                  onClick: submitLogin,
                }, loginBusy ? t('loginBusy') : t('loginSubmit'))
              ),
              h('p', { className: 'mc-formNote' }, t('loginSecurityNote'))
            )
          }

          
          function renderAuthCard() {
            return h('section', { className: 'mc-card', key: 'auth' },
              h('h2', { className: 'mc-cardTitle' }, t('loginTitle')),
              renderAuthTabs(),
              authTab === 'scan' ? renderScanForm() : renderLoginForm()
            )
          }

          // ------------------------------------------------------ 状态卡
function renderExpires() {
            var expiresAt = status ? status.expiresAt : null
            if (!expiresAt) return '—'
            var text = formatDateTime(expiresAt)
            if (Number(expiresAt) < Date.now()) return t('expired') + ' · ' + text
            return text
          }

          /** 打开显示名编辑：草稿 = 当前存储值（不是脱敏号码）。 */
          function openDisplayNameEdit() {
            setDisplayNameDraft(displayName)
            setDisplayNameError('')
            setDisplayNameEdit(true)
          }

          /**
           * 保存显示名。只有「真想存的值写不进 localStorage」才算失败：
           * 空值存不存得进去都无所谓（清除本来就是回退到脱敏号码）。
           */
          function saveDisplayName() {
            var next = normalizeDisplayName(displayNameDraft)
            setDisplayName(next)
            var applied = writeDisplayName(next)
            if (applied !== next) {
              setDisplayNameError(t('actFailed', { detail: 'localStorage' }))
              return
            }
            setDisplayNameError('')
            setDisplayNameEdit(false)
          }

          function clearDisplayName() {
            setDisplayName('')
            setDisplayNameDraft('')
            writeDisplayName('')
            setDisplayNameError('')
            setDisplayNameEdit(false)
          }

          /** 取消：不落盘，直接回到卡片。 */
          function cancelDisplayNameEdit() {
            setDisplayNameDraft('')
            setDisplayNameError('')
            setDisplayNameEdit(false)
          }

          /**
           * 账号行：显示名（有的话）或脱敏手机号 accountMasked。
           * ⚠️ 绝不渲染 status.account —— 那是完整手机号。
           * 有显示名时，脱敏号码退成下面一行小字（仍然不是完整号码）。
           */
// ------------------------------------------------------ 文件浏览
          // ================================================================
          // 0.3.0 资源管理器渲染
          // ================================================================

          /**
           * 顶部工具条。
           *
           * 布局按用户要求：
           *   · 左上 = 账号 + 授权有效期（+ 下载目录小按钮）
           *   · 顶部居中 = 容量
           *   · 右上 = 操作按钮
           */
          function renderExTop() {
            var quota = status ? status.quota : null
            var total = quota && isFinite(Number(quota.totalBytes)) ? Number(quota.totalBytes) : 0
            var used = quota && isFinite(Number(quota.usedBytes)) ? Number(quota.usedBytes) : 0
            var percent = total > 0 ? Math.min(100, Math.max(0, (used / total) * 100)) : 0

            // ---- 左上：账号 + 有效期 ----
            // 账号区：纵向三行（手机号 / 有效期 / 下载目录），保持原来的高度
            var accountBlock = h('div', { className: 'mc-exTopLeft' },
              h('div', { className: 'mc-exAcct' },
                h('span', { className: 'mc-exAcctName', title: accountMasked || '' },
                  hasAccount ? accountLabel : t('notAuthorized')
                ),
                hasAccount ? h('button', {
                  type: 'button',
                  className: 'mc-exAcctEdit',
                  title: t('displayName'),
                  'aria-label': t('displayName'),
                  onClick: openDisplayNameEdit,
                }, '✎') : null
              ),
              displayName !== '' && hasAccount
                ? h('span', { className: 'mc-exAcctMasked' }, accountMasked)
                : null,
              h('div', { className: 'mc-exExpiry' },
                h('span', {}, t('expiresShort')),
                h('span', { className: expiresSoon() ? 'mc-exExpiryWarn' : '' }, renderExpires())
              ),
              // 下载目录：小按钮（带框，限宽）
              h('button', {
                type: 'button',
                className: 'mc-exChip',
                title: (t('downloadDir') + '：' + (downloadDir || '—')),
                onClick: openDirModal,
              },
                h('span', { className: 'mc-exChipIcon' },
                  h('svg', { viewBox: '0 0 10 12', width: 9, height: 11, 'aria-hidden': 'true' },
                    h('path', {
                      d: 'M5 1.5 L5 10',
                      fill: 'none',
                      stroke: 'currentColor',
                      strokeWidth: '1.5',
                      strokeLinecap: 'round',
                    }),
                    h('path', {
                      d: 'M2 7.4 L5 10.4 L8 7.4',
                      fill: 'none',
                      stroke: 'currentColor',
                      strokeWidth: '1.5',
                      strokeLinecap: 'round',
                      strokeLinejoin: 'round',
                    })
                  )
                ),
                h('span', { className: 'mc-exChipValue' }, downloadDir || '—')
              )
            )

            // ---- 容量条：第一行右侧，紧挨操作按钮 ----
            // ---- 容量条：顶部栏底部那条贯通的进度线 ----
            // 文字直接压在条里居中；白字 + 深色描边，所以不管底下是浅色未用区
            // 还是品牌色已用区，都看得清（亮色/暗色主题都适配）。
            var quotaBlock = h('div', {
              className: 'mc-exQuotaLine',
              title: total > 0
                ? t('quota') + '：' + formatBytes(used) + ' / ' + formatBytes(total) + ' · ' + percent.toFixed(1) + '%'
                : t('quotaUnavailable'),
            },
              h('div', {
                className: 'mc-exQuotaLineFill',
                style: { width: (total > 0 ? percent : 0).toFixed(1) + '%' },
              }),
              h('div', { className: 'mc-exQuotaLineText' },
                total > 0
                  ? formatBytes(used) + ' / ' + formatBytes(total) + ' · ' + percent.toFixed(1) + '%'
                  : t('quotaUnavailable')
              )
            )

            // ---- 右上：操作 ----
            var activeCount = (Array.isArray(jobs) ? jobs : []).filter(isJobActive).length
            // 右上：按钮 + 容量条横着排成一行（不换行）
            var actionBlock = h('div', { className: 'mc-exTopRight' },
              // 传输记录
              h('button', {
                type: 'button',
                className: 'mc-btn mc-btnSmall mc-exHistoryBtn',
                title: t('historyTitle'),
                onClick: function () {
                  fetchTransfers()
                  setHistoryOpen(true)
                },
              },
                h('span', { className: 'mc-exHistoryLabel' }, t('history')),
                h('span', { className: 'mc-exHistoryLabelShort' }, t('historyShort')),
                activeCount > 0 ? h('span', { className: 'mc-exHistoryDot' }) : null
              ),
              h('button', {
                type: 'button',
                className: 'mc-btn mc-btnSmall',
                title: t('reauthorize'),
                disabled: authBusy,
                onClick: openReauth,
              }, t('reauthorizeShort')),
              h('button', {
                type: 'button',
                className: 'mc-btn mc-btnSmall mc-btnDanger',
                title: t('clearAuth'),
                disabled: authBusy,
                onClick: clearAuth,
              }, t('clearAuthShort')),
              h('button', {
                type: 'button',
                className: 'mc-btn mc-btnSmall',
                title: t('refresh'),
                'aria-label': t('refresh'),
                disabled: statusLoading,
                onClick: function () {
                  // 刷新不仅是刷容量和列表，树的结构也可能变了
                  invalidateTreeKnowledge()
                  loadStatus()
                  reload()
                },
              }, '↻'),
            )

            return h('div', { className: 'mc-exTop' },
              // 第一行：账号 + 操作按钮（容量条不在这儿了，所以永远塞得下）
              h('div', { className: 'mc-exTopRow' }, accountBlock, actionBlock),
              // 第二行：新建 + 面包屑 + 搜索
              renderExTools(),
              // 底部：贯通的容量条（它就是原来那条浅横线）
              quotaBlock
            )
          }

          /** 授权剩余天数是否已不足 7 天（用于把有效期标红）。 */
          function expiresSoon() {
            var expiresAt = status ? Number(status.expiresAt) : 0
            if (!expiresAt) return false
            return expiresAt - Date.now() < 7 * 24 * 3600 * 1000
          }

          /** 第二行：新建 / 路径 / 搜索。 */
          function renderExTools() {
            return h('div', { className: 'mc-exTools' },
              h('button', {
                type: 'button',
                className: 'mc-btn mc-btnSmall',
                disabled: busy,
                title: t('newFolder'),
                onClick: function () {
                  setFolderOpen(!folderOpen)
                  setFolderName('')
                },
              }, '+ ' + t('newFolder')),
              h('div', { className: 'mc-exToolsGrow' }, renderCrumbs()),
              h('div', { className: 'mc-exSearch' },
                h('input', {
                  className: 'mc-exSearchInput',
                  type: 'search',
                  spellCheck: false,
                  autoComplete: 'off',
                  placeholder: t('searchPlaceholder'),
                  'aria-label': t('search'),
                  value: searchKeyword,
                  onChange: function (event) { setSearchKeyword(event.target.value) },
                  onKeyDown: function (event) {
                    if (event.key === 'Enter') runSearch(searchKeyword)
                    if (event.key === 'Escape') clearSearch()
                  },
                }),
                searchKeyword
                  ? h('button', {
                      type: 'button',
                      className: 'mc-exSearchClear',
                      title: t('searchClear'),
                      onClick: clearSearch,
                    }, '×')
                  : null
              )
            )
          }

          /** 左树的一个节点（含子节点，递归）。 */
          /**
           * 左树的一个节点。
           *
           * 箭头这块踩过坑：一开始用 ▼ / ▶ / · 三个字符表示「展开 / 收起 / 加载中」，
           * 结果是
           *   · 三个字符宽度不同，切换时整行左右跳；
           *   · 没子目录时用 visibility:hidden 把字藏了，用户就看见箭头「点了消失」；
           *   · 字符切换没有过渡，观感很卡。
           *
           * 现在改成：固定 9px 的格子 + 一个 SVG 折角，展开靠 rotate 过渡。
           * 任何状态都不改宽度，所以永远不跳。没有子目录时格子留白（不是消失）。
           */
          function renderCaret(node, hasKids) {
            // 加载中：小转圈（占同样宽度）
            if (node.loading) {
              return h('span', { className: 'mc-exCaretSlot' },
                h('span', { className: 'mc-exTreeSpinner' })
              )
            }
            // 确定没有子目录：留白占位，不画箭头（但位置永远在，不会跳）
            if (!hasKids) {
              return h('span', { className: 'mc-exCaretSlot' })
            }
            return h('span', { className: 'mc-exCaretSlot' },
              h('svg', {
                className: 'mc-exCaret' + (node.open ? ' mc-exCaretOpen' : ''),
                viewBox: '0 0 10 10',
                width: 10,
                height: 10,
                'aria-hidden': 'true',
              },
                h('path', {
                  d: 'M3.5 2 L7 5 L3.5 8',
                  fill: 'none',
                  stroke: 'currentColor',
                  strokeWidth: '1.6',
                  strokeLinecap: 'round',
                  strokeLinejoin: 'round',
                })
              )
            )
          }

          function renderTreeNode(node, depth) {
            var isActive = treeFocusId === node.id
            var kids = node.children || []

            // 「有没有下一级」是三态：
            //   true  → 画箭头，可点
            //   false → 确实没有下级，**不画箭头也不可点**
            //   null  → 还不知道（正在探测），不画箭头但可点（点了就去加载）
            var known = node.hasKids
            var hasKids = known === true
            var canToggle = known !== false
            // 展开过一次并且拿到了子节点，就一定是有下级的
            if (node.loaded && kids.length > 0) {
              hasKids = true
              canToggle = true
            }
            var showKids = node.open && kids.length > 0

            return h('div', { key: 'tn' + node.id },
              h('div', {
                className: 'mc-exTreeNode' + (isActive ? ' mc-exTreeNodeActive' : ''),
                style: { paddingLeft: String(depth * 14 + 2) + 'px' },
              },
                h('button', {
                  type: 'button',
                  className: 'mc-exTreeToggle',
                  tabIndex: -1,
                  title: hasKids ? (node.open ? t('collapse') : t('expand')) : '',
                  'aria-label': hasKids ? (node.open ? t('collapse') : t('expand')) : '',
                  disabled: !canToggle,
                  onClick: function (event) {
                    event.stopPropagation()
                    if (!canToggle) return
                    toggleTreeNode(node.id)
                  },
                }, renderCaret(node, hasKids)),
                h('button', {
                  type: 'button',
                  className: 'mc-exTreeLabel',
                  title: node.id === '/' ? '/' : node.name,
                  onClick: function () { selectTreeNode(node.id) },
                  // 左树里也能右键：把它当成一个文件夹项交给同一套菜单，
                  // 这样「上传到这儿 / 新建文件夹 / 复制路径 / 改名 / 删除」在树里也能用。
                  onContextMenu: function (event) {
                    if (node.id === '/' || node.id === '') return
                    event.preventDefault()
                    event.stopPropagation()
                    openMenu(event, { id: node.id, name: node.name, type: 'folder' })
                  },
                  onDoubleClick: function () {
                    // 双击 = 展开（资源管理器里双击目录就是展开）
                    if (canToggle && !node.open) toggleTreeNode(node.id)
                  },
                },
                  h('span', { className: 'mc-exTreeIcon' }, node.open && kids.length ? '📂' : '📁'),
                  h('span', { className: 'mc-exTreeName' }, node.id === '/' ? '/' : node.name)
                )
              ),
              node.open && kids.length
                ? h('div', { className: 'mc-exTreeKids' },
                    kids.map(function (kid) { return renderTreeNode(kid, depth + 1) })
                  )
                : null
            )
          }

          function renderExTree() {
            // 拖过就用用户选的固定宽度，没拖过就让 CSS 自适应
            var treeStyle = treeWidth !== null ? { width: treeWidth + 'px', flex: '0 0 ' + treeWidth + 'px' } : undefined
            return h('aside', {
              className: 'mc-exTree' + (treeShown ? '' : ' mc-exTreeHidden'),
              style: treeStyle,
            },
              h('div', { className: 'mc-exTreeHead' },
                h('span', {}, t('folders'))
              ),
              h('div', { className: 'mc-exTreeScroll' },
                renderTreeNode(treeRoot, 0)
              )
            )
          }

          /**
           * 可拖动的分隔线。
           *
           * 单独成一个 6px 宽的窄条：中间画 2px 的竖线，
           * 平时几乎看不见，hover / 拖动时才明显 —— 这样既有可拖区域又不占视觉。
           */
          function renderTreeSplitter() {
            if (!treeShown) return null
            return h('div', {
              className: 'mc-exSplitter' + (resizing ? ' mc-exSplitterActive' : ''),
              role: 'separator',
              'aria-orientation': 'vertical',
              title: t('treeResizeHint'),
              onMouseDown: beginTreeResize,
              onDoubleClick: resetTreeWidth,
            },
              h('span', { className: 'mc-exSplitterBar' })
            )
          }

          /** 资源管理器风格的一行。 */
          function renderExRow(item) {
            var isFolder = item && item.type === 'folder'
            var selected = selectedId === item.id
            // 搜索结果多带 parentPath，用于告诉用户它在哪
            var where = item.parentPath && item.parentPath !== '/' ? item.parentPath : ''
            return h('div', {
              className: 'mc-exRow' + (selected ? ' mc-exRowSelected' : ''),
              key: item.id,
              title: item.name + (where ? '\n' + where : ''),
              onContextMenu: function (event) { openMenu(event, item) },
              onClick: function () { setSelectedId(item.id) },
              onDoubleClick: isFolder
                ? function () { enterFolder(item) }
                : function () { downloadFile(item) },
            },
              h('div', { className: 'mc-exRowName' },
                h('span', { className: 'mc-exRowIcon' }, isFolder ? '📁' : '📄'),
                isFolder
                  ? h('button', {
                      type: 'button',
                      className: 'mc-exRowTextBtn',
                      onClick: function (event) {
                        event.stopPropagation()
                        enterFolder(item)
                      },
                    }, item.name)
                  : h('span', { className: 'mc-exRowText' }, item.name)
              ),
              h('span', { className: 'mc-exRowSize' }, isFolder ? '—' : formatBytes(item.size)),
              h('span', { className: 'mc-exRowTime' }, formatDateTime(item.updatedAt))
            )
          }

          /** 右侧内容区：搜索结果 / 当前目录 / 空态。 */
          function renderExMain() {
            var searching = searchOpen && searchKeyword.trim() !== ''
            var rows = searching ? searchItems : items
            var rowNodes = rows.map(renderExRow)

            // 列宽走 CSS 变量，行和列头共用同一套，保证永远对齐
            var colVars = {
              '--mc-col-size': colSize + 'px',
              '--mc-col-time': colTime + 'px',
            }

            return h('main', {
              className: 'mc-exMain' + (mainNarrow ? ' mc-narrow' : ''),
              style: colVars,
              ref: mainRef,
            },
              h('div', {
                className: 'mc-exCols' + (colResizing ? ' mc-exColsResizing' : ''),
                ref: colsRef,
                // 和列表滚动条同宽，保证列头与行的可用宽度一致（否则固定列会错位）
                style: scrollbarW > 0 ? { paddingRight: scrollbarW + 'px' } : undefined,
              },
                h('span', { className: 'mc-exColsName' }, t('colName')),
                h('span', { className: 'mc-exColsSize' }, t('colSize')),
                h('span', { className: 'mc-exColsTime' }, t('colModified')),
                // 「大小」左边界：拖它改大小列宽
                h('div', {
                  className: 'mc-exColHandle' + (colResizing === 'size' ? ' mc-exColHandleActive' : ''),
                  style: { left: 'calc(100% - var(--mc-col-size) - var(--mc-col-time))' },
                  role: 'separator',
                  'aria-orientation': 'vertical',
                  title: t('colResizeHint'),
                  onMouseDown: function (event) { beginColResize('size', event) },
                  onDoubleClick: resetColWidth,
                }, h('span', { className: 'mc-exColHandleBar' })),
                // 「大小」右边界：拖它改时间列宽
                h('div', {
                  className: 'mc-exColHandle mc-exColHandleTime' + (colResizing === 'time' ? ' mc-exColHandleActive' : ''),
                  style: { left: 'calc(100% - var(--mc-col-time))' },
                  role: 'separator',
                  'aria-orientation': 'vertical',
                  title: t('colResizeHint'),
                  onMouseDown: function (event) { beginColResize('time', event) },
                  onDoubleClick: resetColWidth,
                }, h('span', { className: 'mc-exColHandleBar' }))
              ),
              searching
                ? h('div', { className: 'mc-exSearchHint' },
                    h('span', {},
                      searchBusy
                        ? t('searching')
                        : h('span', {}, t('searchIn', { path: currentDirPath() })),
                      searchNote ? h('span', { className: 'mc-exSearchHit' }, ' · ' + searchNote) : null
                    ),
                    h('button', {
                      type: 'button',
                      className: 'mc-btn mc-btnSmall',
                      onClick: clearSearch,
                    }, t('searchExit'))
                  )
                : null,
              listError ? h('div', { className: 'mc-exBanner mc-exBannerErr' }, listError) : null,
              notice ? h('div', { className: 'mc-exBanner' }, notice) : null,
              searchError ? h('div', { className: 'mc-exBanner mc-exBannerErr' }, searchError) : null,
              folderOpen
                ? h('div', { className: 'mc-exBanner' },
                    h('div', { className: 'mc-inlineForm' },
                      h('input', {
                        className: 'mc-input',
                        type: 'text',
                        autoFocus: true,
                        value: folderName,
                        placeholder: t('folderName'),
                        onChange: function (event) { setFolderName(event.target.value) },
                        onKeyDown: onEnterKey(createFolder),
                      }),
                      h('button', {
                        type: 'button',
                        className: 'mc-btn mc-btnSmall mc-btnPrimary',
                        disabled: busy || !folderName.trim(),
                        onClick: createFolder,
                      }, t('create')),
                      h('button', {
                        type: 'button',
                        className: 'mc-btn mc-btnSmall',
                        disabled: busy,
                        onClick: function () { setFolderOpen(false); setFolderName('') },
                      }, t('cancel'))
                    )
                  )
                : null,
              h('div', {
                className: 'mc-exScroll',
                ref: listScrollRef,
                onScroll: maybeLoadMore,
                onContextMenu: function (event) { openMenu(event, null) },
              },
                (!searching && listLoading && items.length === 0) || (searching && searchBusy && searchItems.length === 0)
                  ? h('div', { className: 'mc-exEmpty' }, t('loading'))
                  : null,
                !searching && !listLoading && items.length === 0
                  ? h('div', { className: 'mc-exEmpty' }, t('empty'))
                  : null,
                searching && !searchBusy && searchItems.length === 0
                  ? h('div', { className: 'mc-exEmpty' }, searchNote || t('searchNoResult'))
                  : null,
                h('div', { className: 'mc-exRows' }, rowNodes),
                // 触底自动加载的提示：只有真的还有下一批时才出现，且是一行小字，不是按钮
                !searching && nextCursor
                  ? h('div', { className: 'mc-exFeedFoot' },
                      h('span', { className: 'mc-exFeedDot' }),
                      h('span', {}, listLoading ? t('loading') : t('feedMoreHint'))
                    )
                  : null
              )
            )
          }

          /**
           * 底部传输条。
           *
           * 设计要求：平时**看不出来**（和背景同色 / 全透明）；
           * 传文件时出现颜色并随进度推进；传完后保持颜色 5 秒再渐隐。
           */
          function renderExTransfers() {
            var list = sortedJobs(jobs)
            var running = list.filter(isJobActive)
            var failed = list.filter(function (job) { return job && job.state === 'error' })
            var doneCount = list.filter(function (job) { return job && job.state === 'done' }).length

            var fading = transPhase === 'fade'
            var visible = transPhase !== 'idle'
            var indeterminate = running.length > 0 && totalOf(running) === 0
            var percent = Math.min(100, Math.max(0, Number(transPercent) || 0))

            var fillClass = 'mc-exTransFill'
            // 褪色阶段保留最后一次的颜色（成功/失败），只是透明度降下去
            if (transPhase === 'draw') fillClass += ' mc-exTransDraw'
            else if (transPhase === 'done' || (fading && failed.length === 0)) fillClass += ' mc-exTransDone'
            else if (transPhase === 'error' || (fading && failed.length > 0)) fillClass += ' mc-exTransErr'
            if (indeterminate) fillClass += ' mc-exTransIndet'

            // 摘要文字：只在有内容时显示，避免平时占地方。
            // 褪色阶段**保留文字**，让它跟着进度条一起淡出 ——
            // 之前是直接把文字置空，看起来就像「闪一下就没了」，很突兀。
            var summary = ''
            if (running.length > 0) {
              var first = running[0]
              summary = (first.label || t('transfers')) + ' · ' + percent.toFixed(0) + '%'
              if (running.length > 1) summary += ' · ' + t('transfersMore', { count: running.length - 1 })
            } else if (transPhase === 'done' || (fading && failed.length === 0)) {
              summary = t('transfersDone', { count: doneCount })
            } else if ((transPhase === 'error' || fading) && failed.length) {
              summary = t('transfersFailed', { count: failed.length })
            }

            // 褪色时宽度**不收缩**，保持满格，只让颜色融进背景
            var widthText = fading
              ? '100%'
              : indeterminate
                ? '26%'
                : percent.toFixed(1) + '%'

            return h('div', {
              // 浮在面板底部：不管当前在哪个目录、列表滚到哪里，都一定看得见。
              // 之前它只是 flex 流里的最后一块，很容易被挤出可视区或被内容盖住。
              className: 'mc-exTransDock' + (visible ? ' mc-exTransDockActive' : ''),
            },
              h('div', { className: 'mc-exTrans' + (visible ? ' mc-exTransActive' : '') },
                h('div', { className: 'mc-exTransTrack' },
                  h('div', {
                    className: fillClass,
                    style: {
                      width: widthText,
                      opacity: fading ? 0 : visible ? 1 : 0,
                    },
                  })
                )
              ),
              summary
                ? h('div', { className: 'mc-exTransBar' + (fading ? ' mc-exTransBarFade' : '') },
                    h('span', { className: 'mc-exTransSummary', title: summary }, summary),
                    h('span', { className: 'mc-exTransActions' },
                      running.length > 0
                        ? h('button', {
                            type: 'button',
                            className: 'mc-btn mc-btnSmall',
                            onClick: function () { fetchTransfers() },
                          }, t('refresh'))
                        : null
                    )
                  )
                : null
            )
          }

          /** 汇总一组任务的 total（进度条不确定态判断用）。 */
          function totalOf(list) {
            var sum = 0
            for (var i = 0; i < list.length; i += 1) sum += Math.max(0, Number(list[i].total) || 0)
            return sum
          }

          /**
           * 历史传输记录弹层。
           *
           * 数据就是 `jobs`（宿主保留最近 30 分钟的任务），按开始时间倒序。
           * 分三组显示：正在进行 / 已完成 / 失败，这样一眼能看出「还有没有在跑」。
           */
          function renderHistoryModal() {
            if (!historyOpen) return null
            var all = (Array.isArray(jobs) ? jobs : []).slice()
            all.sort(function (a, b) {
              return (Number(b.startedAt) || 0) - (Number(a.startedAt) || 0)
            })
            var active = all.filter(isJobActive)
            var done = all.filter(function (job) { return job && job.state === 'done' })
            var failed = all.filter(function (job) { return job && job.state === 'error' })
            var cancelled = all.filter(function (job) {
              return job && (job.state === 'cancelled' || job.state === 'canceled')
            })

            /**
             * 任务类型图标：上传=向上箭头，下载=向下箭头。
             *
             * 用 SVG 而不是 emoji —— 箭头这类字形在不同字体下大小和粗细差别很大，
             * 而这两个图标在列表里是**对齐参照**，必须稳定。
             */
            function kindIcon(kind) {
              var k = String(kind || '')
              var isUpload = k.indexOf('upload') === 0
              var isDownload = k.indexOf('download') === 0
              if (!isUpload && !isDownload) return h('span', { className: 'mc-exHistIcon' }, '⇄')
              return h('span', {
                className: 'mc-exHistIcon' + (isUpload ? ' mc-exHistIconUp' : ' mc-exHistIconDown'),
                title: isUpload ? t('upload') : t('menuDownloadLocal'),
              },
                h('svg', { viewBox: '0 0 10 12', width: 9, height: 11, 'aria-hidden': 'true' },
                  // 竖线
                  h('path', {
                    d: 'M5 10.5 L5 2',
                    fill: 'none',
                    stroke: 'currentColor',
                    strokeWidth: '1.5',
                    strokeLinecap: 'round',
                  }),
                  // 箭头（上传朝上，下载朝下）
                  h('path', {
                    d: isUpload ? 'M2 4.6 L5 1.6 L8 4.6' : 'M2 7.4 L5 10.4 L8 7.4',
                    fill: 'none',
                    stroke: 'currentColor',
                    strokeWidth: '1.5',
                    strokeLinecap: 'round',
                    strokeLinejoin: 'round',
                  })
                )
              )
            }

            function stateText(job) {
              var s = String(job.state || '')
              if (s === 'done') return t('jobDone')
              if (s === 'error') return t('jobFailed')
              if (s === 'cancelled' || s === 'canceled') return t('jobCancelled')
              if (s === 'queued') return t('jobQueued')
              if (s === 'scan') return t('jobScanning')
              return t('jobRunning')
            }

            function progressText(job) {
              var total = Number(job.total) || 0
              var doneBytes = Number(job.done) || 0
              if (total > 0) {
                return formatBytes(doneBytes) + ' / ' + formatBytes(total) +
                  ' · ' + Math.min(100, Math.round((doneBytes / total) * 100)) + '%'
              }
              return formatBytes(doneBytes)
            }

            function renderItem(job) {
              var isErr = job.state === 'error'
              var isDone = job.state === 'done'
              var running = isJobActive(job)
              var total = Number(job.total) || 0
              var pct = total > 0 ? Math.min(100, ((Number(job.done) || 0) / total) * 100) : 0
              return h('div', { className: 'mc-exHistItem', key: job.id },
                h('div', { className: 'mc-exHistRow' },
                  h('span', { className: 'mc-exHistIcon' }, kindIcon(job.kind)),
                  h('span', { className: 'mc-exHistName', title: job.label || '' }, job.label || '—'),
                  h('span', {
                    className: 'mc-exHistState' + (isErr ? ' mc-exHistStateErr' : isDone ? ' mc-exHistStateOk' : ''),
                  }, stateText(job))
                ),
                h('div', { className: 'mc-exHistMeta' },
                  h('span', {}, progressText(job)),
                  h('span', {}, formatDateTime(job.finishedAt || job.startedAt))
                ),
                running
                  ? h('div', { className: 'mc-exHistBar' },
                      h('div', { className: 'mc-exHistBarFill', style: { width: pct.toFixed(1) + '%' } })
                    )
                  : null,
                isErr && job.error
                  ? h('div', { className: 'mc-exHistErr', title: String(job.error) }, String(job.error))
                  : null
              )
            }

            function section(title, list, emptyHint) {
              if (!list.length) return null
              return h('div', { className: 'mc-exHistSection' },
                h('div', { className: 'mc-exHistSectionHead' }, title + ' · ' + list.length),
                list.map(renderItem)
              )
            }

            var body
            if (!all.length) {
              body = h('div', { className: 'mc-exHistEmpty' }, t('historyEmpty'))
            } else {
              body = h('div', { className: 'mc-exHistBody' },
                section(t('historyActive'), active),
                section(t('historyDone'), done),
                section(t('historyFailed'), failed),
                section(t('historyCancelled'), cancelled)
              )
            }

            return h('div', {
              className: 'mc-overlay',
              onMouseDown: function (event) {
                if (event.target === event.currentTarget) setHistoryOpen(false)
              },
            }, h('div', { className: 'mc-panel mc-exHistPanel' },
              h('div', { className: 'mc-exModalHead' },
                h('h2', { className: 'mc-exModalTitle' }, t('historyTitle')),
                h('button', {
                  type: 'button',
                  className: 'mc-btn mc-btnSmall mc-panelClose',
                  title: t('cancel'),
                  onClick: function () { setHistoryOpen(false) },
                }, '×')
              ),
              body,
              // 右上角已经有 × 关闭了，这里不再放「关闭」按钮（重复）
              h('div', { className: 'mc-panelFoot' },
                // 一键清空：只删记录，不动文件。正在传的任务会保留，所以要先说清楚。
                h('button', {
                  type: 'button',
                  className: 'mc-btn mc-btnSmall mc-btnDanger',
                  disabled: historyBusy || done.length + failed.length + cancelled.length === 0,
                  title: t('historyClear'),
                  onClick: clearHistory,
                }, historyBusy ? t('loading') : t('historyClear')),
                h('button', {
                  type: 'button',
                  className: 'mc-btn mc-btnSmall',
                  disabled: historyBusy,
                  onClick: function () { fetchTransfers() },
                }, t('refresh'))
              )
            ))
          }

          /**
           * 清空传输记录。
           *
           * ⚠️ 只清「记录」，不删网盘/本地文件 —— 宿主那边也只动内存里的任务表。
           * 正在传输的任务不会被动，所以这个操作随时可以做，不会打断下载。
           * 二次确认是因为「清空」听起来像删东西，用户需要知道它不删文件。
           */
          function clearHistory() {
            if (historyBusy) return
            if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
              if (!window.confirm(t('historyClearConfirm'))) return
            }
            setHistoryBusy(true)
            api
              .clearTransfers()
              .then(function (doc) {
                setHistoryBusy(false)
                if (!doc || doc.ok === false) {
                  setListError((doc && doc.error) || t('actFailed', { detail: '' }))
                  return
                }
                // 立刻重拉一次，让列表反映真实的剩余记录（正在跑的还在）
                return fetchTransfers().then(function () {
                  var removed = Number(doc.removed) || 0
                  if (removed > 0) {
                    setNotice(t('historyCleared', { count: removed }))
                    setTimeout(function () { setNotice('') }, 2400)
                  }
                })
              })
              .catch(function (failure) {
                setHistoryBusy(false)
                setListError(messageOf(failure))
              })
          }

          /** 下载目录弹层：手填 + 系统选择目录。 */
          function renderDirModal() {
            if (!dirModal) return null
            var body = h('div', { className: 'mc-panel' },
              h('div', { className: 'mc-exModalHead' },
                h('h2', { className: 'mc-exModalTitle' }, t('downloadDir')),
                h('button', {
                  type: 'button',
                  className: 'mc-btn mc-btnSmall mc-panelClose',
                  title: t('cancel'),
                  onClick: closeDirModal,
                }, '×')
              ),
              h('div', { className: 'mc-exModalRow' },
                h('input', {
                  className: 'mc-input',
                  type: 'text',
                  spellCheck: false,
                  autoComplete: 'off',
                  value: dirDraft,
                  placeholder: 'D:\\Downloads',
                  'aria-label': t('downloadDir'),
                  onChange: function (event) { setDirDraft(event.target.value) },
                  onKeyDown: onEnterKey(saveDownloadDir),
                }),
                h('button', {
                  type: 'button',
                  className: 'mc-btn mc-btnSmall',
                  disabled: dirPickBusy,
                  onClick: pickDownloadDir,
                }, dirPickBusy ? t('loading') : t('chooseDir'))
              ),
              h('p', { className: 'mc-exModalNote' }, t('downloadDirHint')),
              dirError ? h('div', { className: 'mc-banner mc-bannerErr' }, dirError) : null,
              h('div', { className: 'mc-panelFoot' },
                h('button', {
                  type: 'button',
                  className: 'mc-btn mc-btnPrimary',
                  onClick: saveDownloadDir,
                }, t('save')),
                h('button', {
                  type: 'button',
                  className: 'mc-btn',
                  onClick: function () {
                    setDirDraft(status && status.defaultDownloadDir ? status.defaultDownloadDir : '')
                  },
                }, t('resetDefault')),
                h('button', {
                  type: 'button',
                  className: 'mc-btn',
                  onClick: closeDirModal,
                }, t('cancel'))
              )
            )
            return h('div', {
              className: 'mc-overlay',
              onMouseDown: function (event) {
                if (event.target === event.currentTarget) closeDirModal()
              },
            }, body)
          }

          // ------------------------------------------------------ 文件浏览
          function renderCrumbs() {
            // 根就是 "/"，别再用 t('root')（那是「根目录」三个字，会拼成 //windows/实验）。
            // 分隔符只在两段之间出现，所以 "/" + "windows" + "/" + "实验"。
            var crumbs = [
              h('button', {
                key: 'root',
                className: 'mc-crumb',
                title: '/',
                onClick: goRoot,
              }, '/'),
            ]
            for (var i = 0; i < stack.length; i += 1) {
              crumbs.push(h('span', { key: 'sep' + i, className: 'mc-crumbSep' }, '/'))
              crumbs.push(h('button', {
                key: 'crumb' + i,
                className: 'mc-crumb',
                title: stack[i].name,
                onClick: (function (index) {
                  return function () { goCrumb(index) }
                })(i),
              }, stack[i].name))
            }
            return h('nav', {
              className: 'mc-crumbs',
              title: '/' + stack.map(function (s) { return s.name }).join('/'),
            }, crumbs)
          }

// ------------------------------------------------------ 下载目录 / 上传 / 传输
/** 拖拽上传的逐文件进度行（浏览器 → Host 这一段）。 */
          function renderUrlLines() {
            if (!urlItems || urlItems.length === 0) return null
            return h('div', { className: 'mc-urlLines' }, urlItems.map(function (entry) {
              var percent = Math.min(100, Math.max(0, Number(entry.percent) || 0))
              var failed = entry.state === 'error'
              var label = entry.state === 'done'
                ? t('urlUploadDone', { name: entry.name })
                : failed
                  ? entry.name
                  : t('urlUploading', { name: entry.name, percent: percent.toFixed(0) })
              return h('div', { className: 'mc-urlLine', key: 'url' + entry.id },
                h('div', { className: 'mc-urlLineHead' },
                  h('span', { className: 'mc-urlLineName', title: entry.name }, label),
                  h('span', {
                    className: 'mc-urlLinePct' + (failed ? ' mc-urlLineErr' : ''),
                  }, failed ? '❌' : percent.toFixed(0) + '%')
                ),
                h('div', { className: 'mc-bar' },
                  h('div', { className: 'mc-barFill', style: { width: percent.toFixed(0) + '%' } })
                )
              )
            }))
          }

          /**
           * 上传面板里那块拖拽区 —— 现在只有这一个投放面（卡片里那个已经搬进来了）。
           * inPanel = true 时投放走 onPanelDrop（投到面板钉住的目标目录）。
           */
          function renderDropZone(inPanel) {
            return h('div', {
              className: 'mc-drop' + (dragOver ? ' mc-dropActive' : ''),
              onDragEnter: onDragEnter,
              onDragOver: onDragOver,
              onDragLeave: onDragLeave,
              onDrop: inPanel ? onPanelDrop : onDrop,
            },
              h('div', { className: 'mc-dropText' }, dragOver ? t('dropActive') : t('dropZone')),
              h('div', { className: 'mc-dropHint' }, t('dropHint'))
            )
          }

          /** 面板的标题：右键在文件夹上就是「上传到「名字」」，否则是「上传到当前目录」。 */
          function uploadPanelTitleText() {
            var name = uploadTarget && uploadTarget.name ? String(uploadTarget.name) : ''
            return name
              ? t('uploadPanelTitle', { name: name })
              : t('uploadPanelHere')
          }

          /**
           * 上传面板：fixed 居中的浮层 + 面板。
           * 打开它不发任何请求；只有面板自己的选择按钮和往拖拽区里投放才会起上传。
           * 关掉的方式：右上角 ✕ / Escape / 点浮层背景（点面板里不关）。
           */
          /**
           * 浮层挂到 document.body 上。
           * 插件根节点 `.mc-root` 是 overflow-y:auto 的滚动容器，直接在里面渲染 fixed 浮层
           * 会被祖先的层叠/裁剪上下文吃掉（实测：点「拖动上传」后面板不显示）。
           * 同仓库的 dsh-archive-manager / structured-prompt 都是这个写法；拿不到 react-dom 就退回内联。
           */
          var reactDom = null
          try {
            reactDom = require('react-dom')
          } catch (failure) {
            reactDom = null
          }

          function portalToBody(node) {
            if (reactDom && typeof reactDom.createPortal === 'function' &&
                typeof document !== 'undefined' && document && document.body) {
              return reactDom.createPortal(node, document.body)
            }
            return node
          }

          function renderUploadPanel() {
            if (!uploadOpen) return null
            // 面板里的选择按钮只钉住面板的目标目录，和卡片上那两个互不牵连。
            var panelTarget = uploadTarget && uploadTarget.id !== undefined && uploadTarget.id !== null
              ? uploadTarget.id
              : parentId
            var overlay = h('div', {
              className: 'mc-overlay',
              ref: dragGuardRef,
              // onMouseDown 而不是 onClick：合上菜单的那一下点击不会误关面板。
              onMouseDown: function (event) {
                if (event && event.target !== event.currentTarget) return
                closeUploadPanel()
              },
              onContextMenu: function (event) {
                if (event && typeof event.preventDefault === 'function') event.preventDefault()
              },
            },
              h('div', { className: 'mc-panel', role: 'dialog', 'aria-modal': 'true' },
                h('div', { className: 'mc-panelHead' },
                  h('h2', {
                    className: 'mc-panelTitle',
                    title: uploadPanelTitleText(),
                  }, uploadPanelTitleText()),
                  h('button', {
                    type: 'button',
                    className: 'mc-btn mc-panelClose',
                    title: t('close'),
                    'aria-label': t('close'),
                    onClick: closeUploadPanel,
                  }, '✕')
                ),
                h('p', { className: 'mc-hint' }, t('uploadPanelHint')),
                renderDropZone(true),
                dropNote ? h('div', { className: 'mc-banner mc-bannerOk' }, dropNote) : null,
                renderUrlLines(),
                h('div', { className: 'mc-panelFoot' },
                  h('button', {
                    className: 'mc-btn',
                    disabled: picking,
                    onClick: function () { pickFiles(panelTarget) },
                  }, t('pickFile')),
                  h('button', {
                    className: 'mc-btn',
                    disabled: picking,
                    onClick: function () { pickFolder(panelTarget) },
                  }, t('pickFolder')),
                  // 对话框是模态的，可能开着好几分钟：明说在等谁。
                  picking ? h('span', { className: 'mc-notice' }, t('pickWaiting')) : null
                )
              )
            )
            return portalToBody(overlay)
          }

          /**
           * 上传卡：三个按钮（选文件 / 选文件夹 / 打开上传面板）→
           * 折叠起来的「或直接填路径」。拖拽区不在这里，在上传面板里。
           */
          function renderUploadCard() {
            // 只有「系统对话框还开着」才禁用选择按钮：起完任务后上传是 Host 那边的活，
            // 不该把选择按钮一直锁住（拖拽上传大文件时也是同理）。
            var pickerBusy = picking
            return h('section', { className: 'mc-card', key: 'upload' },
              h('div', { className: 'mc-cardHead' },
                h('h2', { className: 'mc-cardTitle' }, t('upload'))
              ),
              h('div', { className: 'mc-pickRow' },
                h('button', {
                  className: 'mc-btn mc-btnPrimary',
                  disabled: pickerBusy,
                  onClick: function () { pickFiles(parentId) },
                }, t('pickFile')),
                h('button', {
                  className: 'mc-btn',
                  disabled: pickerBusy,
                  onClick: function () { pickFolder(parentId) },
                }, t('pickFolder')),
                h('button', {
                  className: 'mc-btn',
                  onClick: function () { openUploadPanel(null) },
                }, t('dragUploadOpen')),
                // 对话框是模态的，可能开着好几分钟：明说在等谁。
                picking ? h('span', { className: 'mc-notice' }, t('pickWaiting')) : null
              ),
              h('p', { className: 'mc-hint' }, t('pickHint')),
              h('hr', { className: 'mc-sep' }),
              dropNote ? h('div', { className: 'mc-banner mc-bannerOk' }, dropNote) : null,
              renderUrlLines(),
              h('div', { className: 'mc-disclosure' },
                h('button', {
                  type: 'button',
                  className: 'mc-linkBtn',
                  'aria-expanded': pathOpen ? 'true' : 'false',
                  onClick: function () { setPathOpen(!pathOpen) },
                }, (pathOpen ? '▾ ' : '▸ ') + t('orTypePath')),
                pathOpen ? h('div', { className: 'mc-inlineForm' },
                  h('input', {
                    className: 'mc-input',
                    type: 'text',
                    spellCheck: false,
                    autoComplete: 'off',
                    ref: uploadInputRef,
                    value: uploadPath,
                    placeholder: t('uploadPath'),
                    onChange: function (event) { setUploadPath(event.target.value) },
                    onKeyDown: onEnterKey(startUpload),
                  }),
                  h('button', {
                    className: 'mc-btn mc-btnSmall mc-btnPrimary',
                    disabled: jobBusy === 'upload' || jobBusy === 'drop' || !uploadPath.trim(),
                    onClick: startUpload,
                  }, jobBusy === 'upload' ? t('loading') : t('uploadToCurrent'))
                ) : null,
                pathOpen ? h('p', { className: 'mc-hint' }, t('uploadPathHint')) : null
              )
            )
          }

/** 新的在前，最多 TRANSFER_VISIBLE 条。 */
          function sortedJobs(list) {
            var copy = (Array.isArray(list) ? list.slice() : []).filter(function (job) {
              return job && job.id
            })
            copy.sort(function (a, b) {
              return (Number(b.startedAt) || 0) - (Number(a.startedAt) || 0)
            })
            return copy.slice(0, TRANSFER_VISIBLE)
          }

// ------------------------------------------------------ 组装
          //
          // 两条完全不同的形态：
          //   · 未登录 / 首屏加载 → 原来的居中卡片流（登录页按用户要求**不改**）
          //   · 已登录         → 资源管理器（顶部栏 + 左树 + 右列表 + 底部传输条）
          if (!status && statusLoading) {
            return h('div', { className: 'mc-root' },
              h('div', { className: 'mc-loading' }, t('loading'))
            )
          }

          if (!authorized) {
            return h('div', { className: 'mc-root' },
              h('div', { className: 'mc-head' },
                h('div', {},
                  h('h1', { className: 'mc-title' }, t('title')),
                  h('p', { className: 'mc-subtitle' }, t('subtitle'))
                )
              ),
              statusError ? h('div', { className: 'mc-banner mc-bannerErr' }, statusError) : null,
              h('div', { className: 'mc-stack' }, renderAuthCard()),
              renderMenu(),
              renderUploadPanel(),
              renderMovePicker()
            )
          }

          // ---- 已登录：资源管理器 ----
          /**
           * 根节点高度。
           *
           * 🔴 这里踩过大坑：CSS 的 `height:100%` 只有在**父元素有确定高度**时才生效。
           * DSH 的 view 容器不一定给高度，于是 `height:100%` 静默失效，
           * 面板按内容高度撑开 → 整个面板变成一条长页面 →
           *   · 列表内部永远滚不起来（它根本没被压缩）；
           *   · 底部进度条被推到内容最底下，要拖外层滚动条到底才看得见。
           * 这完全对得上用户看到的现象。
           *
           * 所以这里改成：挂载后**实测父容器的像素高度**，直接写死到根节点上，
           * 并用 ResizeObserver 跟随侧栏折叠/窗口缩放变化。CSS 的 100% 只当兜底。
           */
          return h('div', {
            className: 'mc-root mc-root-ide',
            ref: ideRootRef,
            style: ideHeight ? { height: ideHeight + 'px', minHeight: ideHeight + 'px' } : undefined,
            /**
             * ⚠️ 这里**不要**挂 onWheel 去拦滚轮。
             *
             * 之前试过：为了不让滚动链把外层对话页带跑，在根节点上
             * stopPropagation 掐掉滚轮。结果列表直接滚不动了 ——
             * 滚动虽然主要是浏览器默认行为，但一旦中途 stopPropagation，
             * 依赖冒泡的滚动逻辑（以及某些输入法/手势路径）就断了。
             *
             * 现在改成纯 CSS 方案：所有滚动容器加 `overscroll-behavior: contain`，
             * 既能断开滚动链，又完全不干预原生滚动。
             */
          },
            h('div', { className: 'mc-explorer' },
              renderExTop(),
              // 重新授权时把登录卡以浮层形式盖上来，不打乱布局
              reauthOpen ? h('div', {
                className: 'mc-overlay',
                onMouseDown: function (event) {
                  if (event.target === event.currentTarget) setReauthOpen(false)
                },
              }, h('div', { className: 'mc-panel' },
                h('div', { className: 'mc-exModalHead' },
                  h('h2', { className: 'mc-exModalTitle' }, t('reauthorize')),
                  h('button', {
                    type: 'button',
                    className: 'mc-btn mc-btnSmall mc-panelClose',
                    title: t('cancel'),
                    onClick: function () { setReauthOpen(false) },
                  }, '×')
                ),
                renderAuthCard()
              )) : null,
              statusError ? h('div', { className: 'mc-exBanner mc-exBannerErr' }, statusError) : null,
              authError ? h('div', { className: 'mc-exBanner mc-exBannerErr' }, authError) : null,
              h('div', { className: 'mc-exBody' },
                renderExTree(),
                renderTreeSplitter(),
                renderExMain()
              ),
              renderExTransfers()
            ),
            // 浮层：菜单 / 上传 / 转移 / 下载目录 / 历史记录
            renderMenu(),
            renderUploadPanel(),
            renderMovePicker(),
            renderDirModal(),
            renderHistoryModal()
          )
        }
      }

      // ---------------------------------------------------------------- 入口
      function apply(ctx) {
        try {
          ensureStyle()

          var t = translate(ZH)
          try {
            if (ctx && ctx.locale && typeof ctx.locale.register === 'function') {
              ctx.effect(function () {
                return ctx.locale.register(NS, { zh: ZH, en: EN })
              }, 'dsh-mcloud: dictionaries')
            }
            if (ctx && ctx.locale && typeof ctx.locale.bind === 'function') {
              t = ctx.locale.bind(NS)
            }
          } catch (failure) {
            // 字典是锦上添花：拿不到就退回内置中文。
            logWarn('locale unavailable', failure)
          }

          var Panel = createPanel(t)

          /**
           * 收起/还原主输入框。
           *
           * 这个槽位只会渲染当前选中的那个页签，组件挂载即代表「本页签被选中」；
           * 所以本组件一挂载就等于「移动云盘」这个 tab 被选中 —— 这一页不需要
           * 输入框，收起来而不是把它挡住。
           */
          function setComposerHidden(hidden) {
            try {
              if (typeof document === 'undefined') return
              var body = document.querySelector('[data-conversation-content]')
              if (body === null) return
              var seats = body.querySelectorAll('[data-composer-seat]')
              for (var i = 0; i < seats.length; i += 1) {
                var seat = seats[i]
                if (hidden) {
                  if (seat.dataset.mcHidden !== '1') {
                    seat.dataset.mcHiddenBefore = seat.style.display
                    seat.style.display = 'none'
                    seat.dataset.mcHidden = '1'
                  }
                } else if (seat.dataset.mcHidden === '1') {
                  seat.style.display = seat.dataset.mcHiddenBefore || ''
                  delete seat.dataset.mcHidden
                  delete seat.dataset.mcHiddenBefore
                }
              }
            } catch (failure) {
              logWarn('composer toggle failed', failure)
            }
          }

          function clearComposerHidden() {
            setComposerHidden(false)
          }

          /** View 标签的挂载点：挂载 = 这个 tab 被选中。 */
          function ViewMount() {
            React.useEffect(function () {
              setComposerHidden(true)
              return function () { setComposerHidden(false) }
            }, [])
            return h(Panel)
          }

          // 会话窗口顶部的 View 标签栏：内置页签是 对话(0) / 轨迹(10) / 划过的视频(20)，
          // 本插件用 order 30 排在它们后面；装了其他插件则按各自 order 插空。
          try {
            var registeredViews = []
            function registerView() {
              if (registeredViews.length > 0) return
              var dispose = ctx.slots.register({
                name: 'conversation.view',
                id: 'mobile-cloud-view',
                order: 30,
                scope: 'session',
                label: function () {
                  var resolved = t('nav')
                  return resolved === 'nav' ? '移动云盘' : resolved
                },
                locale: NS,
              }, ViewMount)
              registeredViews.push(typeof dispose === 'function' ? dispose : function () {})
            }
            function dropView() {
              for (var i = 0; i < registeredViews.length; i += 1) {
                try {
                  registeredViews[i]()
                } catch (failure) {
                  logWarn('view dispose failed', failure)
                }
              }
              registeredViews.length = 0
              clearComposerHidden()
            }
            ctx.effect(function () {
              return ctx.slots.inject('conversation.view', function () {
                registerView()
                return dropView
              })
            }, 'dsh-mcloud: conversation view tab')
          } catch (failure) {
            logError('conversation view failed', failure)
          }
        } catch (failure) {
          // apply 绝不往外抛。
          logError('apply failed', failure)
        }
      }

      var module = { exports: {} }
      var exports = module.exports
      Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
      exports.inject = ['slots', 'locale']
      exports.apply = apply
      exports.ZH = ZH
      exports.EN = EN
      return module.exports
    },
  })
}
