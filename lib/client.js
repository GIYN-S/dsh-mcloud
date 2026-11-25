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
        renameHint: '给「{name}」换个名字',
        renameEmpty: '新名字不能为空',
        renameDone: '已重命名为「{name}」',
        renameFailed: '重命名失败，原因见上方提示',
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
        menuMove: '转移到…',
        menuMultiMove: '转移选中的 {count} 项…',
        menuMultiRemove: '删除选中的 {count} 项',
        multiRemoveConfirm: '确定删除选中的 {count} 项？此操作不可恢复。',
        multiRemoveDone: '已删除 {count} 项',
        moveMultiSource: '把选中的 {count} 项转移到：',
        moveHereMulti: '转移 {count} 项到「{name}」',
        moveDoubleClickHint: '单击选中，双击进入文件夹；点上面的路径可以直接回到任意一级。',
        moveTreeHint: '单击选中目标文件夹，双击展开/收起；展开过的层级会一直留在上面。',
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
        currentPath: '当前路径：',
        newFolderInTree: '在这个文件夹里新建子文件夹',
        selectedCount: '已选 {count} 项',
        multiBtn: '多选',
        multiEnter: '进入多选模式',
        multiExit: '退出多选模式',
        selectRow: '选中这一项（可多选）',
        selectAll: '全选当前列表',
        clearSelection: '取消选择',
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
        historyReveal: '定位',
        historyRevealDown: '在资源管理器里定位到这个文件',
        historyRevealUp: '跳转到它在网盘里的位置',
        historyRevealMoving: '定位中…',
        historyRevealMoved: '无法定位：这个文件已经被移动或删除了',
        historyRevealRemoteMoved: '无法定位：它已经不在网盘里的那个位置了',
        historyTabUpload: '上传',
        historyTabDownload: '下载',
        historyCount: '共 {count} 条',
        historyLoadMore: '加载更多',
        historyLoadMoreBusy: '加载中…',
        historyOpenFolder: '打开记录文件所在文件夹',
        historyOpenFolderHint: '传输记录保存在本机，永不自动删除',
        // 0.4.7：删除的是**记录**，不是文件
        historyClearTab: '一键删除{family}记录',
        historyClearTabConfirm: '删除全部 {count} 条{family}传输记录？\n\n⚠️ 只删记录，网盘里的文件和本机下载好的文件都不会被删除。\n正在传输中的任务会保留。',
        historyClearTabDone: '已删除 {count} 条{family}记录',
        historyClearTabNone: '没有可删除的{family}记录',
        historyRemoveOne: '删除这条记录',
        historyRemoveOneConfirm: '删除「{name}」这条传输记录？\n\n⚠️ 只删记录，文件不会被删除。',
        historyRemoveOneDone: '已删除这条记录',
        historyRemoveRunning: '这个任务还在传输中，先取消再删记录',
        historyFamilyUpload: '上传',
        historyFamilyDownload: '下载',
        historyOpenFolderUnsupported: '当前运行的宿主还是旧版本，重启 DeepSeek Harness 后这个功能才可用。',
        historyPersisted: '记录已保存在本机',
        revealUploadDone: '已切换到「{path}」',
        revealUploadHere: '当前就在这个目录：{path}',
        revealUnavailable: '这条记录没有可定位的位置',
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
        // 右侧文件区整体就是投放区：拖到「文件名那一条竖线右边、容量条下面」即可上传
        listDropHere: '松开鼠标 → 上传到当前目录',
        listDropHint: '拖到这一块的任何位置都行（名称 / 大小 / 时间列、空白处都可以）。',
        listDropFolder: '拖进来的是文件夹，请用「上传文件夹…」',
        listDropFolderQueued: '正在上传文件夹里的 {count} 个文件到「{path}」（会按原来的层级建好目录）',
        listDropFolderEmpty: '这个文件夹里没有可上传的文件（空目录或读不到内容）。',
        orTypePath: '或直接填路径',
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
        confirmDownloadFolder: '「{name}」会由服务端打包成一个 zip 再下载，大目录可能要等一会儿。确定要下载整个文件夹吗？',
        downloadStarted: '已开始下载：{name}',
        downloadFolderStarted: '已开始下载文件夹：{name}',
        uploadStarted: '已开始上传：{name}',
        downloadDone: '已下载：{name}',
        uploadDone: '已上传：{name}',
        downloadFailed: '下载失败：{name}',
        uploadFailed: '上传失败：{name}',
        phasePrepare: '准备',
        phaseHash: '校验哈希',
        phaseCreate: '创建任务',
        phaseUpload: '上传中',
        phaseScan: '扫描目录',
        phaseArchive: '服务端打包中',
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
        renameHint: 'Rename “{name}”',
        renameEmpty: 'The new name cannot be empty',
        renameDone: 'Renamed to “{name}”',
        renameFailed: 'Rename failed — see the message above',
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
        menuMove: 'Move to…',
        menuMultiMove: 'Move {count} selected item(s)…',
        menuMultiRemove: 'Delete {count} selected item(s)',
        multiRemoveConfirm: 'Delete the {count} selected item(s)? This cannot be undone.',
        multiRemoveDone: 'Deleted {count} item(s)',
        moveMultiSource: 'Move the {count} selected item(s) to:',
        moveHereMulti: 'Move {count} item(s) to "{name}"',
        moveDoubleClickHint: 'Single-click to select, double-click to open a folder; click any level above to jump back.',
        moveTreeHint: 'Single-click to select the target folder, double-click to expand/collapse; expanded levels stay visible.',
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
        currentPath: 'Current path: ',
        newFolderInTree: 'Create a subfolder inside this folder',
        selectedCount: '{count} selected',
        multiBtn: 'Select',
        multiEnter: 'Enter multi-select mode',
        multiExit: 'Exit multi-select mode',
        selectRow: 'Select this item (multi-select)',
        selectAll: 'Select all in this list',
        clearSelection: 'Clear selection',
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
        historyReveal: 'Locate',
        historyRevealDown: 'Reveal this file in the file manager',
        historyRevealUp: 'Jump to its folder on the drive',
        historyRevealMoving: 'Locating…',
        historyRevealMoved: 'Cannot locate: the file has been moved or deleted',
        historyRevealRemoteMoved: 'Cannot locate: it is no longer in that folder on the drive',
        historyTabUpload: 'Uploads',
        historyTabDownload: 'Downloads',
        historyCount: '{count} record(s)',
        historyLoadMore: 'Load more',
        historyLoadMoreBusy: 'Loading…',
        historyOpenFolder: 'Open the folder holding the records file',
        historyOpenFolderHint: 'Transfer records live on this machine and are never deleted automatically',
        historyClearTab: 'Delete all {family} records',
        historyClearTabConfirm: 'Delete all {count} {family} transfer record(s)?\n\nThe files on the drive and on disk are NOT deleted — only the records.\nTransfers still running are kept.',
        historyClearTabDone: 'Deleted {count} {family} record(s)',
        historyClearTabNone: 'No {family} records to delete',
        historyRemoveOne: 'Delete this record',
        historyRemoveOneConfirm: 'Delete the transfer record for "{name}"?\n\nOnly the record is deleted — the file is untouched.',
        historyRemoveOneDone: 'Record deleted',
        historyRemoveRunning: 'This transfer is still running — cancel it first.',
        historyFamilyUpload: 'upload',
        historyFamilyDownload: 'download',
        historyOpenFolderUnsupported: 'The running host is an older build — restart DeepSeek Harness to enable this.',
        historyPersisted: 'Records are stored on this machine',
        revealUploadDone: 'Switched to "{path}"',
        revealUploadHere: 'Already in this folder: {path}',
        revealUnavailable: 'This record has no location to show',
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
        listDropHere: 'Release to upload to the current folder',
        listDropHint: 'Anywhere in this area works (name / size / time columns and empty space).',
        listDropFolder: 'That was a folder — use “Upload a folder…” instead',
        listDropFolderQueued: 'Uploading {count} file(s) from that folder into “{path}” (keeping the folder structure)',
        listDropFolderEmpty: 'That folder had no uploadable files (empty, or its contents could not be read).',
        orTypePath: 'Or type a path',
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
        confirmDownloadFolder: 'The whole folder "{name}" is packed into a zip on the server before download, so a large folder may take a while. Download it?',
        downloadStarted: 'Download started: {name}',
        downloadFolderStarted: 'Folder download started: {name}',
        uploadStarted: 'Upload started: {name}',
        downloadDone: 'Downloaded: {name}',
        uploadDone: 'Uploaded: {name}',
        downloadFailed: 'Download failed: {name}',
        uploadFailed: 'Upload failed: {name}',
        phasePrepare: 'preparing',
        phaseHash: 'hashing',
        phaseCreate: 'creating',
        phaseUpload: 'uploading',
        phaseScan: 'scanning',
        phaseArchive: 'packing on the server',
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
      /**
       * 选中行的背景色（0.4.8 引入，0.4.9 调淡）。
       *
       * 必须**明显区别于 hover**，否则就是用户报的那个现象：
       * 「点了是选中的，鼠标一移上去颜色又和没选一样了」。
       *
       * 但也不能太亮 —— 0.4.8 用了品牌色 16%，用户反馈「多选点完之后太亮了」
       * （一整列多选时尤其刺眼）。现在降到 8%：比 hover 的 0.12 灰还轻，
       * 但**色相不同**（偏蓝），所以一眼就能和悬停区分开，又不抢视觉。
       */
      var SELECT_BG = 'var(--dsw-alias-bg-selected,rgba(79,140,255,.08))'
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
        // 拖拽区：0.3.5 之后不再有上传面板里的虚线框，拖放直接在右侧文件区里做
        // （蒙层样式见下面 .mc-exDropLayer）。这里保留 .mc-drop 只给登录页等旧容器兜底。
        '.mc-drop{box-sizing:border-box;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;min-height:96px;padding:16px 14px;border:1.5px dashed ' + LINE + ';border-radius:12px;background:transparent;text-align:center}',
        '.mc-dropActive{border-color:' + GREY_2 + ';background:' + LAYER_2 + '}',
        '.mc-dropText{font-size:13px;line-height:19px;color:' + GREY_2 + '}',
        '.mc-dropActive .mc-dropText{color:' + GREY_1 + '}',
        '.mc-dropHint{font-size:11px;line-height:16px;color:' + GREY_2 + '}',
        // 浮层：盖住整屏 + 居中面板。菜单的 z-index 是 80，这里必须更高。
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
        '.mc-moveList{display:flex;flex-direction:column;gap:2px;max-height:280px;overflow-y:auto;overscroll-behavior:contain;padding:2px}',
        '.mc-moveRow{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;box-sizing:border-box;padding:8px 10px;border:0;border-radius:8px;background:transparent;color:inherit;font-size:13px;text-align:left;cursor:pointer}',
        '.mc-moveRow:hover{background:' + LAYER_2 + '}',
        '.mc-moveRowDisabled{opacity:.45;cursor:not-allowed}',
        '.mc-moveTag{flex:none;font-size:11px;color:' + DANGER + '}',
        // 0.4.5 转移面板：改成和左树一样的目录树
        '.mc-movePanel{width:min(520px,100%);display:flex;flex-direction:column;min-height:0}',
        '.mc-mvTreeWrap{display:flex;flex-direction:column;min-height:0;flex:1 1 auto;border:0.5px solid ' + LINE + ';border-radius:8px;overflow:hidden;background:' + LAYER_1 + '}',
        '.mc-mvTreeHead{flex:none;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 10px;border-bottom:0.5px solid ' + LINE + ';font-size:11px;line-height:16px;color:' + GREY_2 + '}',
        '.mc-mvTreeTarget{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:' + GREY_1 + ';font-weight:600}',
        '.mc-mvTreeScroll{flex:1 1 auto;min-height:0;max-height:min(46vh,340px);overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;padding:4px}',
        '.mc-mvNode{cursor:pointer;padding-top:2px;padding-bottom:2px}',
        '.mc-mvNodeDisabled{opacity:.45;cursor:not-allowed}',
        '.mc-moveFootHint{font-size:11px;line-height:16px;color:' + GREY_2 + ';margin:8px 0 0}',
        // 多选提示条（0.4.4 第 5 条）
        '.mc-exSelectBar{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
        '.mc-exSelectText{flex:1 1 auto;min-width:0;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        // 多选复选框列（0.4.5）：平时淡，鼠标移到行上或已选中时变明显
        // 多选复选框列（0.4.9）：默认宽度 0（完全不占位），
        // 打开多选模式时由 .mc-multiOn 把 --mc-check-w 改成 24px。
        '.mc-multiOn{--mc-check-w:24px}',
        /**
         * 列头容器（0.4.10）：按钮绝对定位，网格独占整行宽度。
         *
         * 🔴 0.4.9 的两个残留问题，这次一起收掉：
         *
         *   1. 「不点多选时名称还是被遮住，点了多选就不遮」
         *      —— 因为两档只差 24px，而按钮本身比预留的 66px 更宽。
         *      现在把「按钮占位」统一成一个 CSS 变量 --mc-multi-w，
         *      非多选 / 多选**都用它**（只额外加复选框那一列的宽度），
         *      并且给到 84px 的余量（按钮实测约 62px + 左边距 14px）。
         *
         *   2. 「点多选之后按钮变白、字看不见」
         *      —— 原来 ON 态是 `background:品牌色 + color:#fff`。
         *      一旦主题里 --dsw-alias-brand-primary 是浅色（或用户用浅色主题），
         *      就变成白底白字。现在**不再用白字**：ON 态用当前主题的前景/层色，
         *      靠「加粗 + 品牌色描边 + 淡底」来表达「已开启」，任何主题都读得出来。
         */
        /**
         * 🔴 0.4.11：这个位置改了四次，前三次全错，教训写死在这儿。
         *
         *   0.4.6 按钮塞进 grid 当第一个格子 → 占掉复选框列，名称被挤出视口
         *   0.4.8 外面包 flex              → 网格可用宽度变小，名称照样被挤
         *   0.4.9/10 绝对定位 + 手动 padding-left → 预留宽度永远算不准，
         *             **不点多选时名称被遮、点多选反而不遮**
         *
         * 三次错法的共同点：**用手算的宽度去跟浏览器的自动布局对抗** ——
         * 只要还在算 padding / 绝对定位，就一定会差几个像素。
         *
         * 现在换成根本不需要算：列头网格比行网格**多一个前置列**装按钮，
         * 宽度由网格自己分配，按钮列 / 复选框列 / 名称列永远不会重叠。
         */
        /**
         * 列头 / 行统一的 4 列布局（0.4.13 按用户要求重排）：
         *
         *   [ 名称 1fr ] [ 复选框+多选按钮 ] [ 大小 ] [ 修改时间 ]
         *                              ↑
         *                     紧贴「大小」左边线
         *
         * 用户要求：
         *   · 名称和下面的文件不要再贴着左边线 → 名称列给足左边距；
         *   · 复选框 + 多选按钮整体挪到「大小」列左边线的**左侧**。
         *
         * 关键：列头与行用**同一套 4 列模板**，格子数也**都是 4 个**，
         * 所以永远不会错位（0.4.12 的教训：格子少一个就整行错乱）。
         */
        '.mc-exMain{--mc-multi-w:92px}',
        '.mc-multiOn{--mc-check-w:24px}',
        /**
         * 🔴 0.4.12：真正的根因不是宽度，是**子元素个数和网格列数不匹配**。
         *
         * 用户截图（图1，未开多选）：名称列头的字只剩一个「名」、文件行里名字整段消失、
         * 大小/时间整体右移、时间末尾被切。开多选（图2）却一切正常。
         *
         * 原因很朴素：
         *   · 行网格定义是 4 列 `check | 1fr | size | time`；
         *   · 但未开多选时，renderExRow **根本不渲染那个复选框格子**（返回 null）；
         *   · 于是这一行只有 3 个子元素 → 被依次塞进前 3 列：
         *       名称 → 第1列（--mc-check-w = 0px，直接被裁没）
         *       大小 → 第2列（1fr，右对齐，看起来跑到右边）
         *       时间 → 第3列（size 宽度，末尾被切）
         *   列头同理（checkCell 用了 display:none，一样从网格里消失）。
         *
         * 所以：**网格子元素必须永远和列一一对应**。
         * 未开多选时保留一个宽度为 0 的空格子（而不是 null / display:none），
         * 名称自然落回「名称列」。
         */
        /**
         * 第 2 列：复选框 + 多选按钮，**紧贴「大小」左边线**（用户要求）。
         *
         * 这一列宽度 = check + multi 两个变量之和。
         * 内容右对齐，所以按钮和多选框都贴着右边（也就是「大小」那条竖线）。
         */
        '.mc-exColsMultiCell{display:flex;align-items:center;justify-content:flex-end;gap:6px;min-width:0;padding-right:6px}',
        '.mc-exColsCheckCell{display:flex;align-items:center;justify-content:center;padding:0}',
        // ⚠️ 不要给复选框格子用 display:none —— 它一旦消失，后面的格子会整体错一列。
        // 宽度由网格列的 --mc-check-w（0px / 24px）控制，元素本身必须一直在。
        '.mc-exColsCheckHidden{display:flex}',
        // 「多选」开关按钮：放在「名称」左边
        /**
         * 多选按钮本体。
         *
         * 🔴 ON 态**不能用白字**。原来写的是 `background:品牌色 + color:#fff`，
         * 一旦 --dsw-alias-brand-primary 是浅色（或浅色主题下为白），
         * 就是白底白字 —— 用户看到的就是「点了多选按钮变成白色，字看不见了」。
         *
         * 现在 ON 态改成：
         *   · 底色：品牌色 14% 淡底（不刺眼，且和未选中态明显不同）
         *   · 文字：用主题的**主文字色**（永远和背景有对比度）
         *   · 再加粗 + 品牌色描边，三重信号表达「已开启」
         */
        '.mc-exMultiBtn{flex:none;appearance:none;display:inline-flex;align-items:center;gap:4px;border:0.5px solid ' + LINE + ';border-radius:6px;background:transparent;color:' + GREY_2 + ';font-size:11px;line-height:15px;padding:2px 7px;margin:0;cursor:pointer;transition:background-color .14s ease,color .14s ease,border-color .14s ease;white-space:nowrap}',
        '.mc-exMultiBtn:hover{background:' + LAYER_2 + ';color:' + GREY_1 + ';border-color:' + GREY_2 + '}',
        '.mc-exMultiBtnOn{background:rgba(79,140,255,.14);border-color:var(--dsw-alias-brand-primary,#4f8cff);color:' + GREY_1 + ';font-weight:600}',
        '.mc-exMultiBtnOn:hover{background:rgba(79,140,255,.2);border-color:var(--dsw-alias-brand-primary,#4f8cff);color:' + GREY_1 + '}',
        '.mc-exMultiIcon{flex:none;font-size:11px;line-height:1}',
        '.mc-exMultiLabel{flex:none;white-space:nowrap}',
        '@media (max-width:960px){.mc-exMultiLabel{display:none}}',
        // 行里的第 2 格：复选框（和多选按钮同一个位置，紧贴「大小」左边线）
        '.mc-exRowCheckCell{display:flex;align-items:center;justify-content:flex-end;gap:6px;padding:0 6px 0 0;min-width:0}',
        '.mc-exRowCheck{appearance:auto;width:13px;height:13px;margin:0;cursor:pointer;accent-color:var(--dsw-alias-brand-primary,#4f8cff);opacity:.35;transition:opacity .12s ease}',
        '.mc-exRow:hover .mc-exRowCheck,.mc-exRowSelected .mc-exRowCheck{opacity:1}',
        '.mc-exRowCheck:disabled{opacity:.2;cursor:default}',
        // 记录弹层内的定位失败提示（0.4.4 第 2 条）
        '.mc-exHistNotice{display:flex;align-items:flex-start;gap:8px;margin:0 0 8px;flex:none}',
        '.mc-exHistNoticeText{flex:1 1 auto;min-width:0;word-break:break-word}',
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
        // 「当前路径：」标签（0.4.4 第 4 条占位；0.4.5 调大）
        '.mc-exPathLabel{flex:none;font-size:13px;line-height:20px;font-weight:500;color:' + GREY_1 + ';white-space:nowrap;user-select:none}',

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
        // 树头的「+ 新建文件夹」（0.4.4 第 4 条：按钮挪到文件夹区右侧）
        '.mc-exTreeAdd{flex:none;appearance:none;display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;padding:0;border:0.5px solid ' + LINE + ';border-radius:5px;background:transparent;color:' + GREY_2 + ';font-size:13px;line-height:1;font-weight:600;cursor:pointer;transition:background-color .14s ease,color .14s ease,border-color .14s ease}',
        '.mc-exTreeAdd:hover:not(:disabled){background:' + LAYER_2 + ';color:' + GREY_1 + ';border-color:' + GREY_2 + '}',
        '.mc-exTreeAdd:disabled{opacity:.45;cursor:default}',
        // overscroll-behavior:contain —— 滚到底别把滚动传给外层对话页
        '.mc-exTreeScroll{flex:1 1 0;min-height:0;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;padding:4px 4px 10px}',
        '.mc-exTreeNode{display:flex;align-items:center;gap:3px;min-width:0;border-radius:6px}',
        '.mc-exTreeNode:hover{background:' + LAYER_2 + '}',
        // 🔴 选中态必须压过 hover，否则鼠标一移上去就「看起来没选中」了
        '.mc-exTreeNodeActive,.mc-exTreeNodeActive:hover{background:' + SELECT_BG + '}',
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
        // 三角标「后出现」时淡入一下，避免从一个空格子里硬跳出来。
        // 注意：这里只管透明度过渡，不引入任何「未知占位」元素。
        '.mc-exCaret{animation:mc-caretIn .12s ease-out}',
        '@keyframes mc-caretIn{from{opacity:0}to{opacity:1}}',
        // 子节点容器：展开时淡入，避免"啪"一下出现
        '.mc-exTreeKids{animation:mc-exTreeIn .14s ease-out}',
        '@keyframes mc-exTreeIn{from{opacity:0}to{opacity:1}}',
        '.mc-exTreeLabel{flex:1 1 auto;min-width:0;appearance:none;display:flex;align-items:center;gap:5px;border:0;background:transparent;font:inherit;font-size:12px;line-height:18px;color:' + GREY_1 + ';text-align:left;padding:3px 4px;border-radius:5px;cursor:pointer;overflow:hidden}',
        '.mc-exTreeIcon{flex:none;font-size:12px;line-height:1}',
        '.mc-exTreeName{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.mc-exTreeLoading{flex:none;font-size:10px;color:' + GREY_2 + '}',
        // 树里的「继续加载」：比正常节点淡，明确是占位而不是真目录

        // 右列表
        // position:relative 是给「拖放蒙层」和「逐文件进度卡」用的绝对定位锚点
        '.mc-exMain{position:relative;flex:1 1 0;display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden}',
        // 列头（像资源管理器那样）
        /**
         * 列头网格（0.4.11）：**多给一列专门放「多选」按钮**。
         *
         * 🔴 这已经是第四次改这个位置了，前三次全错，把教训写死在这儿：
         *
         *   0.4.6 按钮塞进 grid 当第一个格子 → 占掉复选框列，名称被挤出视口
         *   0.4.8 外面包 flex → 网格可用宽度变小，名称照样被挤
         *   0.4.9/10 按钮绝对定位浮着 + 给名称加 padding-left
         *            → 预留宽度永远算不准（66px 不够、84px 又太挤），
         *              **不点多选时名称被遮、点多选反而不遮**
         *
         * 三次错法的共同点：**手动算宽度跟自动布局对抗**。
         * 只要还在用手算的 padding / 绝对定位，就一定会差几个像素。
         *
         * 现在换成根本不需要算的办法：
         *   · 列头网格比行的网格**多一个前置列** `var(--mc-multi-w)`，专门装按钮；
         *   · 按钮就是这个列的普通格子（不 absolute、不 padding 补偿）；
         *   · 网格自己保证「按钮列 + 复选框列 + 名称列」互不重叠 ——
         *     浏览器排版，宽度永远不会算错；
         *   · 行的网格不变（仍然只有 复选框/名称/大小/时间 四列），
         *     所以行和列头的「大小 / 时间」两条竖线依然严格对齐。
         */
        /**
         * 列头网格（0.4.12）：先复选框、再「多选」按钮，最后名称。
         *
         * 用户要求：「一键选择按钮和多选换个位置」→ 复选框在前、多选按钮在后。
         *
         * 关键点：列头比行**多一个按钮列**（--mc-multi-w）。为了让「名称 / 大小 / 时间」
         * 三条竖线仍然和行对齐，行这边用同一个变量做 padding-left：
         *
         *   列头： [check] [multi] [name 1fr] [size] [time]      ← 网格自己分配
         *   行  ： padding-left = (check + multi) 后接 [name 1fr] [size] [time]
         *
         * 两边「名称列左边距」都等于 check + multi，所以永远对齐；
         * 而且用的是**同一个 CSS 变量**，不是手敲的数字，不会再差几像素。
         */
        '.mc-exCols{position:relative;flex:none;display:grid;grid-template-columns:minmax(0,1fr) calc(var(--mc-check-w,0px) + var(--mc-multi-w,92px)) var(--mc-col-size,84px) var(--mc-col-time,132px);align-items:stretch;gap:0;height:29px;padding:0;box-sizing:border-box;border-bottom:0.5px solid ' + LINE + ';font-size:11px;line-height:16px;color:' + GREY_2 + ';user-select:none}',
        // ⚠️ 用「面板自身宽度」而不是视口宽度判断：对话区可能很窄，但整个浏览器窗口很宽，
        // 媒体查询（基于视口）在这种布局下会失效，三列直接挤成一团。
        // 这里由 JS 量 .mc-exMain 的宽度挂上 mc-narrow 类。
        '.mc-exMain.mc-narrow .mc-exCols{grid-template-columns:minmax(0,1fr) calc(var(--mc-check-w,0px) + var(--mc-multi-w,92px)) var(--mc-col-size,72px)}',
        '.mc-exMain.mc-narrow .mc-exColsTime{display:none}',
        '.mc-exMain.mc-narrow .mc-exColHandleTime{display:none}',
        // 名称列：不再贴左边线（用户要求），给足左边距
        '.mc-exColsName{display:flex;align-items:center;min-width:0;padding:0 8px 0 clamp(12px,1.8vw,20px);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
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
        /**
         * 行网格：**保留复选框列**（宽度 0 / 24px 由变量控制），
         * 这样行的第一格永远是复选框格子，名称绝不会被顶到第 1 列去。
         *
         * 列头在复选框列之后还多一个「多选按钮列」，所以这边用 padding-left 补上，
         * 让名称列起点和列头一致：
         *   列头： [check] [multi] [name...]
         *   行  ： padding-left(multi) 后接 [check] [name...]
         *          ↑ 注意顺序不同：行的 check 在 padding 之后
         *
         * 更简单也更不容易错的做法在下面：行也**不渲染** check 列，
         * 直接用 padding-left 让出 check+multi 两列的总宽。
         */
        '.mc-exRow{display:grid;grid-template-columns:minmax(0,1fr) calc(var(--mc-check-w,0px) + var(--mc-multi-w,92px)) var(--mc-col-size,84px) var(--mc-col-time,132px);align-items:stretch;gap:0;min-height:29px;padding:0;box-sizing:border-box;font-size:13px;line-height:19px;cursor:default;position:relative}',
        '.mc-exMain.mc-narrow .mc-exRow{grid-template-columns:minmax(0,1fr) calc(var(--mc-check-w,0px) + var(--mc-multi-w,92px)) var(--mc-col-size,72px)}',
        '.mc-exMain.mc-narrow .mc-exRowTime{display:none}',
        /**
         * 行的背景：hover 与 selected 的层级必须**选中 > 悬停**，否则会「选着选着变浅了」。
         *
         * 🔴 0.4.8 用户反馈：「点击所选文件就高亮，但鼠标移上去怎么又和未选择的一样了」。
         *
         * 原因就是这里：原来 hover 用 LAYER_1（0.06）、selected 用 LAYER_2（0.12），
         * 而 CSS 里 `:hover` 写在 `.mc-exRowSelected` 前面，看起来像是重叠了 ——
         * 但两者真正打架的地方在**树节点**（下面 .mc-exTreeNode 那一段）：
         * 那里 hover 的 LAYER_1 优先级更高、把选中态的 LAYER_2 盖掉了。
         *
         * 现在统一成：hover = LAYER_2（0.12），selected = 独立的「选中色」，
         * 并且显式写出 `.mc-exRowSelected:hover` 保持选中色不变深也不变浅。
         */
        '.mc-exRow:hover{background:' + LAYER_2 + '}',
        // 选中：用一支比 hover 更明显的品牌色淡底 + 左侧短竖线（资源管理器的做法）
        '.mc-exRowSelected,.mc-exRowSelected:hover{background:' + SELECT_BG + '}',
        '.mc-exRowSelected::before{content:"";position:absolute;left:2px;top:50%;transform:translateY(-50%);width:2px;height:14px;border-radius:1px;background:var(--dsw-alias-brand-primary,#4f8cff)}',
'.mc-exRowName{display:flex;align-items:center;gap:7px;min-width:0;padding:0 8px 0 clamp(12px,1.8vw,20px);overflow:hidden}',
        '.mc-exRowIcon{flex:none;font-size:13px;line-height:1}',
        '.mc-exRowText{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.mc-exRowTextBtn{appearance:none;border:0;background:transparent;font:inherit;color:inherit;text-align:left;padding:0;cursor:pointer;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        // 左右竖线要贯穿整列：列头有，每一行也必须有，否则只有表头那一段有线
        '.mc-exRowSize{display:flex;align-items:center;justify-content:flex-end;font-size:12px;color:' + GREY_2 + ';font-variant-numeric:tabular-nums;padding:0 8px;border-left:0.5px solid ' + LINE + ';border-right:0.5px solid ' + LINE + ';overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.mc-exRowTime{display:flex;align-items:center;justify-content:flex-end;font-size:12px;color:' + GREY_2 + ';font-variant-numeric:tabular-nums;padding:0 clamp(8px,1.2vw,14px) 0 8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        // 提示条 / 空态 / 加载
        '.mc-exBanner{flex:none;margin:6px clamp(8px,1.2vw,14px) 0;border-radius:8px;padding:6px 10px;font-size:12px;line-height:17px;background:' + LAYER_1 + ';word-break:break-word}',
        '.mc-exBannerErr{color:' + DANGER + '}',
        '.mc-exBannerWarn{color:var(--dsw-alias-state-warning-primary,#b8860b)}',
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

        // ---- 右侧文件区 = 拖放上传区 ----
        // 用户要求：不再有「拖动上传」这个菜单项和上传面板，直接把文件拖到
        // 「名称列的竖线右边、容量条下面」这一整块，松手就传到当前目录。
        // 所以这里铺一层蒙层，拖拽悬停时给整块区域高亮 + 一句提示。
        '.mc-exDropLayer{position:absolute;inset:0;z-index:30;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;pointer-events:none;background:rgba(127,127,127,.10);border:2px dashed ' + GREY_2 + ';border-radius:10px;margin:4px}',
        '.mc-exDropCard{display:flex;flex-direction:column;align-items:center;gap:6px;max-width:min(420px,100%);padding:16px 20px;border-radius:12px;background:var(--dsw-alias-bg-layer-3,#ffffff);box-shadow:0 8px 26px rgba(0,0,0,.22);text-align:center}',
        '.mc-exDropIcon{font-size:22px;line-height:1}',
        '.mc-exDropTitle{font-size:13px;line-height:19px;font-weight:600;color:' + GREY_1 + '}',
        '.mc-exDropPath{max-width:100%;font-size:11px;line-height:16px;color:' + GREY_2 + ';overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        // 逐文件进度卡：钉在右侧文件区右上角，传完自动消失（不用开面板）
        '.mc-exDropProgress{position:absolute;right:10px;top:34px;z-index:25;width:min(300px,calc(100% - 20px));box-sizing:border-box;display:flex;flex-direction:column;gap:6px;padding:9px 11px;border:0.5px solid ' + LINE + ';border-radius:10px;background:var(--dsw-alias-bg-layer-3,#ffffff);box-shadow:0 6px 20px rgba(0,0,0,.16);pointer-events:none}',
        '.mc-exDropProgressTitle{font-size:11px;line-height:16px;color:' + GREY_2 + ';font-weight:600}',

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
        // 0.4.0：上传 / 下载两个页签（跟登录页那套 tab 同款视觉，但不要下边框挤在弹层头下面）
        '.mc-exHistTabs{margin:0 0 8px;flex:none}',
        '.mc-exHistMore{display:flex;justify-content:center;padding:6px 0 2px}',
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
        // 「定位」按钮：跟在每条记录右下角，只对已完成 / 有位置的记录出现
        '.mc-exHistFoot{display:flex;align-items:center;justify-content:flex-end;gap:6px;margin-top:1px}',
        // 记录行里的「删除这条记录」（0.4.7）：和定位同款外形，危险色
        '.mc-exHistRemove{appearance:none;font:inherit;font-size:11px;line-height:15px;display:inline-flex;align-items:center;gap:4px;border:0.5px solid ' + LINE + ';border-radius:6px;background:transparent;color:' + GREY_2 + ';padding:2px 8px;cursor:pointer;transition:background-color .14s ease,color .14s ease,border-color .14s ease}',
        '.mc-exHistRemove:hover:not(:disabled){background:' + LAYER_2 + ';color:' + DANGER + ';border-color:' + DANGER + '}',
        '.mc-exHistRemove:disabled{opacity:.5;cursor:default}',
        // 弹层底栏：左边「一键删除」，右边「打开文件夹 / 刷新」
        '.mc-exHistFoot2{display:flex;align-items:center;gap:6px}',
        '.mc-exHistFootGap{flex:1 1 auto}',
        '.mc-exHistReveal{appearance:none;font:inherit;font-size:11px;line-height:15px;display:inline-flex;align-items:center;gap:4px;border:0.5px solid ' + LINE + ';border-radius:6px;background:transparent;color:' + GREY_2 + ';padding:2px 8px;cursor:pointer;transition:background-color .14s ease,color .14s ease,border-color .14s ease}',
        '.mc-exHistReveal:hover:not(:disabled){background:' + LAYER_2 + ';color:' + GREY_1 + ';border-color:' + GREY_2 + '}',
        '.mc-exHistReveal:disabled{opacity:.5;cursor:default}',
        '.mc-exHistRevealIcon{flex:none;display:inline-flex;align-items:center;justify-content:center;width:9px;height:9px}',

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
      /**
       * 轮询时一次取多少条。
       *
       * 记录永不删除（0.4.0），所以不能像以前那样「全取 20 条当全部」——
       * 这里只取最近一小批用来驱动轮询和底部进度条；完整历史由弹层分页拉。
       */
      var TRANSFER_POLL_LIMIT = 30
      /** 传输记录弹层每页多少条。 */
      var TRANSFER_PAGE_SIZE = 30
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
        archive: 'phaseArchive',
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
        list: function (parentFileId, cursor, pageSize, options) {
          var opts = options || {}
          var query =
            '/list?parentFileId=' + encodeURIComponent(parentFileId || '/') +
            '&cursor=' + encodeURIComponent(cursor || '')
          // 「这个目录有没有子文件夹」的探测用 pageSize，越大一次看得越全。
          if (pageSize) query += '&pageSize=' + encodeURIComponent(String(pageSize))
          /**
           * 宿主默认不吃缓存（见 Host /list 的注释）；只有明确要「回访秒开」才传 cache=1。
           *
           * `refresh=1` 是**给老版本宿主**用的：0.3.x 的 /list 只有看到 refresh=1
           * 才会绕过它那层 60 秒 LRU。带上它对 0.4.x 无害（新宿主只认 cache=1）。
           * 这样即使宿主进程还是旧代码，用户点刷新 / 上传完成后也能看到新内容 ——
           * 不至于「插件和宿主版本错开」时功能就废掉。
           */
          if (opts.force) query += '&refresh=1'
          else if (opts.cache) query += '&cache=1'
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
        upload: function (localPath, parentFileId, name, parentPath) {
          var body = { localPath: localPath, parentFileId: parentFileId }
          if (name) body.name = name
          // 展示用路径：只为「传输记录 → 定位」时给面包屑提供那一级的名字。
          if (parentPath) body.parentPath = parentPath
          return requestJson('POST', '/upload', body)
        },
        /** 整个本机文件夹交给 Host 扫描上传（POST /upload-folder → jobId）。 */
        uploadFolder: function (localPath, parentFileId, parentPath) {
          var body = { localPath: localPath, parentFileId: parentFileId }
          if (parentPath) body.parentPath = parentPath
          return requestJson('POST', '/upload-folder', body)
        },
        /**
         * 拖拽上传：body 是文件原始字节，不是 JSON —— 所以只能用 XMLHttpRequest
         * （fetch 拿不到「浏览器 → Host」这一段的上行进度）。
         * 成功 = HTTP 200 + { ok:true, jobId, name }；失败按 { ok:false, error } 抛出去。
         */
        uploadBody: function (file, parentFileId, onProgress, parentPath) {
          return new Promise(function (resolve, reject) {
            var name = file && file.name ? String(file.name) : 'upload.bin'
            var url = BASE + '/upload-body?name=' + encodeURIComponent(name) +
              '&parentFileId=' + encodeURIComponent(parentFileId || '/')
            if (parentPath) url += '&parentPath=' + encodeURIComponent(parentPath)
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
        download: function (fileId, localPath, name) {
          var body = { fileId: fileId, localPath: localPath }
          if (name) body.name = name
          return requestJson('POST', '/download', body)
        },
        downloadFolder: function (folderId, localPath, name, mode) {
          var body = { folderId: folderId, localPath: localPath }
          if (name) body.name = name
          if (mode) body.mode = mode
          return requestJson('POST', '/download-folder', body)
        },
        cancelTransfer: function (jobId) {
          return requestJson('POST', '/transfer/cancel', { jobId: jobId })
        },
        /**
         * 「传输记录 → 定位」：让宿主在系统资源管理器里选中那条记录对应的本机文件。
         * 传 jobId 就够了（宿主拿任务里记下的 localPath），也允许直接传 localPath。
         *
         * 0.4.0：宿主会先复核「这个文件还在不在原位」，不在就回 400 + 明确的错误文案 ——
         * 这正是用户要的「移动了位置就显示无法定位」。
         */
        reveal: function (jobId, localPath) {
          var body = {}
          if (jobId) body.jobId = jobId
          if (localPath) body.localPath = localPath
          return requestJson('POST', '/reveal', body)
        },
        /**
         * 传输记录列表。
         *
         * 0.4.0 起按「上传 / 下载」分家 + 分页（记录永不删除，可能几百条）。
         * options: { family:'upload'|'download', offset, limit }
         */
        transfers: function (options) {
          var opts = options || {}
          var query = '/transfers'
          var parts = []
          if (opts.family) parts.push('family=' + encodeURIComponent(opts.family))
          if (opts.offset) parts.push('offset=' + encodeURIComponent(String(opts.offset)))
          if (opts.limit) parts.push('limit=' + encodeURIComponent(String(opts.limit)))
          if (parts.length) query += '?' + parts.join('&')
          return requestJson('GET', query)
        },
        transfer: function (jobId) {
          return requestJson('GET', '/transfers?jobId=' + encodeURIComponent(jobId))
        },
        /** 让宿主复核「这条记录还能不能定位」（文件是否被移动/删除）。 */
        checkLocatable: function (jobId) {
          return requestJson('GET', '/transfers/check?jobId=' + encodeURIComponent(jobId))
        },
        /** 让宿主打开「传输记录文件」所在文件夹（记录永不删除，用户自己管理）。 */
        openTransfersFolder: function () {
          return requestJson('POST', '/transfers/open-folder', {})
        },
        /**
         * 删掉一条传输记录（0.4.7）。
         *
         * 🔴 只删记录，**不删文件** —— 网盘上的和本机下载下来的都不动。
         */
        removeTransfer: function (jobId) {
          return requestJson('POST', '/transfers/remove', { jobId: jobId })
        },
        /** 一键删掉一批记录（按 family 分），同样只删记录不删文件。 */
        clearTransfers: function (family) {
          return requestJson('POST', '/transfers/clear', { family: family || '' })
        },
      }

      /**
       * 宿主是不是「老版本」（没有 0.4.0 才有的那几条路由）。
       *
       * 🔴 为什么需要这个：插件的客户端 bundle 和宿主进程是**分开更新**的 ——
       * 换掉 node_modules 里的文件之后，前端会立刻用上新代码，
       * 而宿主进程要重启才会加载新的 index.js。这个窗口里，新客户端会去调
       * /transfers/check、/transfers/open-folder 这些旧宿主根本没有的路由，
       * 落到 DSH 的默认处理器上，用户看到的就是一句 HTTP 404。
       *
       * 所以这里探测一次并记住：老宿主就降级到「能用的那条路」，
       * 而不是把 404 糊到用户脸上。等用户重启 DSH 就自动恢复全部功能。
       */
      var hostCapabilities = { checked: false, locatable: true, recordsFolder: true }

      function detectHostCapabilities() {
        if (hostCapabilities.checked) return Promise.resolve(hostCapabilities)
        hostCapabilities.checked = true
        return api
          .checkLocatable('__probe__')
          .then(function () {
            // 能回来（哪怕是 404 job not found 的 JSON）就说明路由存在。
            return hostCapabilities
          })
          .catch(function (failure) {
            var message = messageOf(failure)
            // 「HTTP 404」是 DSH 默认处理器回的，说明这条路由压根没注册。
            if (/HTTP 404|HTTP 401/.test(message)) {
              hostCapabilities.locatable = false
              hostCapabilities.recordsFolder = false
              logWarn('host is older than 0.4.0, degrading', message)
            }
            return hostCapabilities
          })
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
          /** 提示自动消失的定时器（同一时刻只留一个，新提示覆盖旧提示）。 */
          var noticeTimerRef = React.useRef(null)
          /**
           * 正在「跟踪落地」的那一次传输。
           *
           * 用户要求：点开始 → 显示「已开始下载：xxx」；下载好 → 就地换成
           * 「已下载：xxx」，**5 秒后自己消失**。所以这里记下任务的 id 和两条文案，
           * 轮询到 state 变成 done 的那一刻再换成完成文案 + 5s 定时清除。
           */
          var pendingNoticeRef = React.useRef(null)
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
          var moveOpenState = React.useState(false)
          var moveSourceState = React.useState(null)
          var moveSourcesState = React.useState([])
          /**
           * 转移面板的目录树（0.4.5 第 3 条）。
           *
           * 结构 `{ id, name, open, loading, loaded, children, hasKids }`，
           * 和左树（treeRoot）**完全同一套** —— 用户要求「做成首页左侧文件夹那样的样式」，
           * 那就干脆用同一种数据结构和同一套渲染，行为才不会又走偏。
           */
          var moveTreeState = React.useState(null)
          /** 当前选中的目标目录 id（默认根）。 */
          var moveTargetIdState = React.useState('/')
          var moveBusyState = React.useState(false)
          var moveErrorState = React.useState('')
          var moveOpen = moveOpenState[0]; var setMoveOpen = moveOpenState[1]
          var moveSource = moveSourceState[0]; var setMoveSource = moveSourceState[1]
          /**
           * 多选转移时的全部源项（单文件转移时是空数组，靠 moveSource 走老路径）。
           *
           * 「不能转移到自己里面」这条校验对多选同样成立，所以两个都要留着。
           */
          var moveSources = moveSourcesState[0]; var setMoveSources = moveSourcesState[1]
          var moveTree = moveTreeState[0]; var setMoveTree = moveTreeState[1]
          var moveTargetId = moveTargetIdState[0]; var setMoveTargetId = moveTargetIdState[1]
          var moveBusy = moveBusyState[0]; var setMoveBusy = moveBusyState[1]
          var moveError = moveErrorState[0]; var setMoveError = moveErrorState[1]

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

          /**
           * 重命名弹层（0.4.4 第 7 条）。
           *
           * 老实现用 window.prompt —— Electron 没有这个方法，调用直接返回 null，
           * 于是「重命名」永远静默失效。这里改成自己的输入框。
           */
          var renameTargetState = React.useState(null)
          var renameTarget = renameTargetState[0]
          var setRenameTarget = renameTargetState[1]
          var renameDraftState = React.useState('')
          var renameDraft = renameDraftState[0]
          var setRenameDraft = renameDraftState[1]
          var renameErrorState = React.useState('')
          var renameError = renameErrorState[0]
          var setRenameError = renameErrorState[1]

          /**
           * 传输记录弹层里那条「定位失败」的提示（0.4.4 第 2 条）。
           *
           * 🔴 老代码定位失败时调的是 showNotice(...)，而 showNotice 写的是
           * `.mc-exBanner` —— 那是**文件区**的横幅，挂在记录弹层**下面**，
           * 弹层还盖在上面，所以用户只看到它在「文件名下面」闪一下、或者根本看不见。
           * 现在专门给弹层留一条自己的提示，显示在页签下面。
           */
          var historyNoticeState = React.useState('')
          var historyNotice = historyNoticeState[0]
          var setHistoryNotice = historyNoticeState[1]
          var historyNoticeErrState = React.useState(false)
          var historyNoticeErr = historyNoticeErrState[0]
          var setHistoryNoticeErr = historyNoticeErrState[1]

          function showHistoryNotice(text, isError) {
            setHistoryNotice(text === null || text === undefined ? '' : String(text))
            setHistoryNoticeErr(isError === true)
          }

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

          /**
           * 多选（0.4.4 引入；0.4.6 第 2 条改成**开关模式**）。
           *
           * 用户要求：「名称左边改成一个按钮叫多选按钮，没点之前就和之前版本那样，
           * 点了之后就变成现在的样子」。
           *
           * 也就是：
           *   · 平时（multiSelectMode = false）—— 和 0.4.3 完全一样，
           *     **没有复选框列**，点行就是选中/双击进入，视觉上干净；
           *   · 点「多选」按钮后 —— 复选框列出现，提示条出现，右键菜单变成批量操作。
           *
           * 这比「一直显示复选框」更贴近资源管理器的习惯（Windows 也是按 Ctrl 才切换
           * 成复选模式），而且不占用日常浏览时的横向空间。
           */
          var multiSelectModeState = React.useState(false)
          var multiSelectMode = multiSelectModeState[0]
          var setMultiSelectMode = multiSelectModeState[1]

          var selectedIdsState = React.useState([])
          var selectedIds = selectedIdsState[0]
          var setSelectedIds = selectedIdsState[1]
          /** Shift 连选的锚点（上一次普通点击的 id）。 */
          var selectAnchorRef = React.useRef('')

          function isSelected(id) {
            for (var i = 0; i < selectedIds.length; i += 1) {
              if (selectedIds[i] === id) return true
            }
            return false
          }

          function clearSelection() {
            selectAnchorRef.current = ''
            setSelectedIds([])
          }

          /**
           * 开 / 关多选模式（0.4.6 第 2 条）。
           *
           * 关掉时必须**清空选择** —— 否则复选框列藏起来了，但内部还记着
           * 「已选 3 项」，之后在别处右键会突然冒出「删除选中的 3 项」，
           * 指的还是看不见的东西。这种「隐形状态」是最难查的 bug。
           */
          function toggleMultiSelectMode() {
            setMultiSelectMode(function (previous) {
              var next = !previous
              if (!next) {
                selectAnchorRef.current = ''
                setSelectedIds([])
              }
              return next
            })
          }

          /**
           * 切换某一行的选中状态（复选框用）。
           *
           * 和多选模式下「点行」等价，但不需要用户知道 Ctrl。
           */
          function toggleSelected(id) {
            if (!id) return
            var key = String(id)
            selectAnchorRef.current = key
            setSelectedIds(function (previous) {
              for (var i = 0; i < previous.length; i += 1) {
                if (previous[i] === key) {
                  return previous.slice(0, i).concat(previous.slice(i + 1))
                }
              }
              return previous.concat([key])
            })
          }

          /** 当前可见行（搜索时是搜索结果）。 */
          function visibleRows() {
            var pool = searchOpen && searchKeyword.trim() !== '' ? searchItems : items
            return Array.isArray(pool) ? pool : []
          }

          /** 列头的「全选」：当前可见的行全选 / 全不选。 */
          function toggleSelectAll() {
            var list = visibleRows()
            var ids = []
            for (var i = 0; i < list.length; i += 1) {
              if (list[i] && list[i].id) ids.push(String(list[i].id))
            }
            if (!ids.length) return
            var allSelected = ids.every(function (id) { return isSelected(id) })
            if (allSelected) {
              clearSelection()
              return
            }
            selectAnchorRef.current = ids[0]
            setSelectedIds(ids)
          }

          /** 可见行里是否已经全选（决定列头复选框的勾选态）。 */
          function isAllVisibleSelected() {
            var list = visibleRows()
            if (!list.length) return false
            for (var i = 0; i < list.length; i += 1) {
              if (!list[i] || !list[i].id) continue
              if (!isSelected(String(list[i].id))) return false
            }
            return true
          }

          /** 把「可见行 + 选中集合」折算成真实的项（渲染用）。 */
          function selectedItems() {
            var pool = searchOpen && searchKeyword.trim() !== '' ? searchItems : items
            var picked = []
            for (var i = 0; i < (pool || []).length; i += 1) {
              var row = pool[i]
              if (row && isSelected(row.id)) picked.push(row)
            }
            return picked
          }

          /**
           * 点某一行。
           *
           * 三种情形：
           *   · **多选模式开着**（0.4.6 第 2 条）→ 点行就是切换复选，不需要 Ctrl；
           *   · 普通模式 + Ctrl/Shift → 传统的加选 / 连选（保留，习惯这个的人照旧能用）；
           *   · 普通模式 → 只选这一行（和 0.4.3 一模一样）。
           *
           * 连选范围用当前可见顺序（搜索结果和普通列表都能用）。
           */
          function clickRow(item, event) {
            if (!item || !item.id) return

            // 多选模式：点行 = 勾/取消勾这一项
            if (multiSelectMode) {
              var withShiftInMulti = Boolean(event && event.shiftKey)
              if (withShiftInMulti) {
                applyShiftRange(item)
                return
              }
              toggleSelected(item.id)
              return
            }

            var pool = searchOpen && searchKeyword.trim() !== '' ? searchItems : items
            var list = Array.isArray(pool) ? pool : []
            var withCtrl = Boolean(event && (event.ctrlKey || event.metaKey))
            var withShift = Boolean(event && event.shiftKey)
            var anchor = selectAnchorRef.current

            if (withShift && anchor) {
              applyShiftRange(item)
              return
            }

            if (withCtrl) {
              setSelectedIds(function (previous) {
                for (var k = 0; k < previous.length; k += 1) {
                  if (previous[k] === item.id) {
                    return previous.slice(0, k).concat(previous.slice(k + 1))
                  }
                }
                return previous.concat([item.id])
              })
              selectAnchorRef.current = item.id
              return
            }

            setSelectedIds([item.id])
            selectAnchorRef.current = item.id
          }

          /** Shift 连选：从锚点连到这一行（多选模式和普通模式共用）。 */
          function applyShiftRange(item) {
            if (!item || !item.id) return
            var pool = searchOpen && searchKeyword.trim() !== '' ? searchItems : items
            var list = Array.isArray(pool) ? pool : []
            var anchor = selectAnchorRef.current
            if (!anchor) {
              setSelectedIds([item.id])
              selectAnchorRef.current = item.id
              return
            }
            var from = -1
            var to = -1
            for (var i = 0; i < list.length; i += 1) {
              if (list[i] && list[i].id === anchor && from < 0) from = i
              if (list[i] && list[i].id === item.id && to < 0) to = i
            }
            if (from < 0 || to < 0) {
              setSelectedIds([item.id])
              return
            }
            var start = Math.min(from, to)
            var end = Math.max(from, to)
            var range = []
            for (var j = start; j <= end; j += 1) {
              if (list[j] && list[j].id) range.push(list[j].id)
            }
            setSelectedIds(range)
          }

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
          /**
           * 传输记录弹层的当前页签：'upload' | 'download'（0.4.0 用户要求分两页）。
           */
          var historyTabState = React.useState('download')
          var historyTab = historyTabState[0]
          var setHistoryTab = historyTabState[1]
          /** 每个页签各自的列表 + 分页状态（记录永不删除，可能很多条）。 */
          var historyUploadState = React.useState({ items: [], total: 0, offset: 0, loading: false, error: '' })
          var historyUpload = historyUploadState[0]
          var setHistoryUpload = historyUploadState[1]
          var historyDownloadState = React.useState({ items: [], total: 0, offset: 0, loading: false, error: '' })
          var historyDownload = historyDownloadState[0]
          var setHistoryDownload = historyDownloadState[1]
          /** 「打开记录文件夹」进行中（防连点）。 */
          var historyBusyState = React.useState(false)
          var historyBusy = historyBusyState[0]
          var setHistoryBusy = historyBusyState[1]
          /** 正在「定位」的那条记录 id（防连点 + 按钮上显示「定位中…」）。 */
          var revealBusyState = React.useState('')
          var revealBusy = revealBusyState[0]
          var setRevealBusy = revealBusyState[1]

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
          var urlSeqRef = React.useRef(0)
          var urlTimersRef = React.useRef([])
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

          // ------------------------------------------------------ 提示条
          /**
           * 文件区那一行提示（`.mc-exBanner`）的显示 / 定时清除。
           *
           * 用户要求的行为：
           *   点开始 → 「已开始下载：xxx」（或上传）
           *   传好了 → 就地换成「已下载：xxx」
           *   再过 5 秒 → 自己消失
           *
           * 所以这里统一成一个入口：同一时刻最多一个定时器，新提示直接把旧的顶掉，
           * 不会出现「旧定时器把新提示清空」这种经典 bug。
           */
          var NOTICE_LINGER_MS = 5000

          function clearNoticeTimer() {
            if (noticeTimerRef.current === null) return
            try {
              clearTimeout(noticeTimerRef.current)
            } catch (failure) {
              logWarn('clear notice timer failed', failure)
            }
            noticeTimerRef.current = null
          }

          /** text 为空 = 立刻清掉；ms > 0 = 到点自动清掉；ms = 0/undefined = 一直留着。 */
          function showNotice(text, ms) {
            clearNoticeTimer()
            var value = text === null || text === undefined ? '' : String(text)
            setNotice(value)
            if (value !== '' && ms && ms > 0) {
              noticeTimerRef.current = setTimeout(function () {
                noticeTimerRef.current = null
                setNotice('')
              }, ms)
            }
          }

          /**
           * 开始盯一条传输任务的结局，好在它跑完时把「已开始」换成「已完成」。
           *
           * 任务 POST 只回 jobId，真正的结果只能从 /transfers 轮询里看。
           * 所以这里记住 jobId + 两条文案，fetchTransfers 每轮回来看一眼。
           */
          function watchJobNotice(jobId, texts) {
            var id = jobId === null || jobId === undefined ? '' : String(jobId)
            if (!id) return
            pendingNoticeRef.current = {
              jobId: id,
              done: texts && texts.done ? String(texts.done) : '',
              failed: texts && texts.failed ? String(texts.failed) : '',
            }
          }

          /** 轮询里调：盯着的那个任务到终态了，就把提示换成结局并挂上 5 秒定时器。 */
          function settleJobNotice(job) {
            var pending = pendingNoticeRef.current
            if (!pending || !job || String(job.id) !== pending.jobId) return
            var state = String(job.state || '')
            if (state === 'done') {
              pendingNoticeRef.current = null
              showNotice(pending.done, NOTICE_LINGER_MS)
            } else if (state === 'error') {
              pendingNoticeRef.current = null
              showNotice(pending.failed || pending.done, NOTICE_LINGER_MS)
            } else if (state === 'cancelled' || state === 'canceled') {
              // 取消有自己的提示（cancelJob 里那条），这里只把跟踪放掉，别抢。
              pendingNoticeRef.current = null
            }
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

            /**
             * 首屏一律要**新鲜数据**（force），续页照旧。
             *
             * 「先渲染旧缓存、再后台校准」这件事由上面那个 5 分钟客户端缓存负责，
             * 所以这里校准的请求必须真的打到网盘去 —— 不能再让宿主的 60 秒缓存
             * 把它挡回来。这就是「上传完刷新还是旧列表」那条 bug 的收口点。
             */
            return api.list(parentId, cursor || '', undefined, isFirstPage ? { force: true } : undefined)
              .then(function (doc) {
                if (seqRef.current !== seq) return
                var list = Array.isArray(doc.items) ? doc.items : []
                // 顺手把这层目录的「有没有子文件夹」记下来：下次左树要画它的三角标时
                // 直接命中，不用再探测一次。
                if (isFirstPage) rememberListing(parentId, list)
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

          /**
           * 重拉当前目录。
           *
           * ⚠️ 别在这里动左树（以前在注释里藏了一句被压成一行的 clearListingCache()）。
           * 「刷新」按钮会另外调 invalidateTreeKnowledge()；上传落地走的是
           * refreshAfterUpload() → reload()，那种情况下树也要跟着更新 ——
           * 由下面那个「补齐」effect 按 treeEpoch / 目录变化自动处理。
           */
          function reload() {
            clearListingCache()
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

          // 卸载时一定要停表：不在有任务时才轮询，也绝不漏一个野 interval / 定时器。
          React.useEffect(function () {
            return function () {
              stopTransferPolling()
              clearUrlTimers()
              clearNoticeTimer()
            }
          }, [])

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

          // ------------------------------------------------------ 拖放上传
          /*
           * 拖放上传（0.3.5 重做）。
           *
           * 用户要求：去掉右键里的「拖动上传」那一项 —— 拖拽不该先开一个面板。
           * 现在**右侧文件区本身**就是投放区：把文件拖到「名称列那一条竖线右边、
           * 容量条下面」这一整块（列头、行、空白处都算），松手就传到当前打开的目录。
           *
           * 事件处理函数（stopDragEvent / handleDrop / onDragEnter / onDragOver /
           * onDragLeave）都在下面「投放」那一节，这里只是把设计意图记在原地。
           */
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
           * 树的「重新加载节拍器」。
           *
           * treeEpoch 一变，负责拉子目录的 effect 就跑一遍；
           * treeLoadTryAt / treeFailCount 用来做重试节流 —— 网络抖一下就重拉，
           * 但不会变成死循环（间隔按 1s / 2s / 4s 递增，最多 30 秒一次）。
           */
          var treeEpochState = React.useState(0)
          var treeEpoch = treeEpochState[0]
          var setTreeEpoch = treeEpochState[1]
          var treeLoadTryAt = React.useRef(Object.create(null))
          var treeFailCount = React.useRef(Object.create(null))

          /**
           * 把「树的结构知识」作废：探测缓存、已加载标记。
           *
           * 🔴 这里踩过一个很讨厌的坑（0.3.5 修）：原来的实现是直接把整棵树重置成
           * `{ id:'/', open:true, loaded:false, children: [] }`。
           * 于是只要在**根目录**点一次「刷新」（或者新建/改名/删除之后），
           * 树就只剩一个孤零零的 `/` —— 因为重新拉子目录是靠
           * `useEffect(..., [parentId, authorized])` 触发的，而在根目录上
           * parentId 根本没变，effect 不会重跑，`loadTreeChildren('/')` 永远等不到。
           * 上传完文件有概率看起来像这样，也是同一条链（runMutation → 这里 → 清空）。
           *
           * 现在改成两步：
           *   1. **保留 children 和 open**，只把 loaded 标成 false（旧内容继续可见，
           *      不会出现「树先塌掉再长回来」的闪烁）；
           *   2. bump 一个 treeEpoch，让依赖它的 effect 立刻重新拉一遍。
           * 哪怕这一次拉失败，还有下面那个「补齐」effect 按节流重试。
           */
          function invalidateTreeKnowledge() {
            kidProbeCache = Object.create(null)
            kidProbeInflight = Object.create(null)
            treeLoadTryAt.current = Object.create(null)
            treeFailCount.current = Object.create(null)
            setTreeRoot(function (current) {
              return markTreeStale(current)
            })
            setTreeEpoch(function (previous) { return previous + 1 })
          }

          /** 把一棵子树的 loaded 全部标成 false（**保留 children / open / hasKids**）。 */
          function markTreeStale(node) {
            if (!node) return node
            var kids = node.children || []
            var mapped = kids.map(markTreeStale)
            var changed = mapped.some(function (kid, index) { return kid !== kids[index] })
            if (!changed && node.loaded === false) return node
            return Object.assign({}, node, {
              loaded: false,
              children: mapped,
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
           * 第一页可能全是文件 —— 所以「这一页没有文件夹」还得往后确认。
           *
           * 🔴 0.4.0 性能修正（用户反馈「点文件夹箭头反应太慢」）：
           * 以前是 `pageSize=10` 且最多翻 3 页 = **最多 3 次往返**去回答一个布尔问题。
           * 实测单次 200~900ms，三个来回就是一秒多；而且树里十几个文件夹同时探测时
           * 会一口气打满浏览器对同源的 6 个连接，把用户真正要的那次「展开」请求堵在后面
           * —— 这才是「点了箭头要等很久」的真实原因。
           *
           * 现在改成 `pageSize=50` 只请求**一次**（50 条里还找不到文件夹，就认为没有：
           * 一个塞了 50 个文件还没有子文件夹的目录，很可能压根就没有子文件夹），
           * 并把并发压到 2、错峰发起（见 probeTreeKids）。
           */
          function probeKid(folderId) {
            var cached = kidProbeCache[folderId]
            if (cached !== undefined && Date.now() - cached.at < KID_PROBE_TTL_MS) {
              return Promise.resolve(cached.has)
            }
            if (kidProbeInflight[folderId]) return kidProbeInflight[folderId]

            var p = api.list(folderId, '', 50)
              .then(function (doc) {
                var items = doc && Array.isArray(doc.items) ? doc.items : []
                var has = false
                for (var i = 0; i < items.length; i += 1) {
                  if (items[i] && items[i].type === 'folder') {
                    has = true
                    break
                  }
                }
                kidProbeCache[folderId] = { has: has, at: Date.now() }
                return has
              })
              .catch(function () {
                // 探测失败就先当作「未知」，不要缓存成 false（否则会永久少一个箭头）
                return null
              })
              .then(function (has) {
                delete kidProbeInflight[folderId]
                return has
              })
            kidProbeInflight[folderId] = p
            return p
          }

          /**
           * 把「一次刚拿到的目录列表」直接记进探测缓存。
           *
           * 🔴 这是 0.4.3 的关键优化：**任何一个已经拿到手的目录列表，都能回答
           * 「这个目录有没有子文件夹」**，没必要为它再发一次探测请求。
           *
           * 什么场合会用到：
           *   · 右侧列表每打开一个目录 → 那个目录的子目录结论立刻就有；
           *   · 用户顺着树点进某个目录 → 同理；
           *   · 展开树节点时本来就会拉一次列表 → 结论顺手就记下了。
           *
           * 于是「回访过的目录」永远是零延迟出现三角标，
           * 只有**这一次会话里第一次见到**的目录才需要真的探测一次。
           */
          function rememberListing(parentId, items) {
            if (!parentId) return
            var list = Array.isArray(items) ? items : []
            var hasFolder = false
            for (var i = 0; i < list.length; i += 1) {
              if (list[i] && list[i].type === 'folder') {
                hasFolder = true
                break
              }
            }
            kidProbeCache[parentId] = { has: hasFolder, at: Date.now() }
          }

          /**
           * 批量探测一组子文件夹。
           *
           * 🔴 0.4.2：**立刻发起、并发拉满**。
           *
           * 之前两个版本在这件事上分别走偏了一次，记下来免得再走回去：
           *
           *   0.3.x：`pageSize=10` 且最多翻 3 页 → 回答一个布尔问题要最多 3 次往返，
           *          而且树里十几个目录同时探测会打满浏览器对同源的 6 条连接，
           *          用户真正点的那个「展开」反而排在后面 → **点箭头要等好几秒**。
           *
           *   0.4.0：为了掩盖这个慢，把「未知」当成「有下级」先画三角标，
           *          再把探测推到后台（并发 1、延后 2 秒）→ 慢的问题被藏起来了，
           *          代价是**空文件夹也会先长出三角标、几秒后才消失**（用户明确否掉）。
           *
           * 现在回到正解：不糊弄显示，而是把探测本身做快 ——
           *   · 每个目录只发**一次**请求（pageSize=50），一次往返就有结论；
           *   · 立刻发起（不延迟）；
           *   · 并发 10：典型目录（一屏 10 个左右子文件夹）**一轮就全部问完**，
           *     不会出现「先出来 4 个三角标、再过 200ms 又冒 3 个」那种逐步跳变；
           *   · 已经在飞的同一个目录不会重复发（kidProbeInflight 去重）；
           *   · **任何已经拿到手的目录列表都会写进缓存**（rememberListing），
           *     所以回访过的目录永远是零延迟出现三角标。
           *
           * 实测（真实账号、根目录 9 个子文件夹）：全部结论在 **约 600ms** 内落地，
           * 单个探测 118~585ms，基本就是一次网络往返的下限。
           */
          var PROBE_CONCURRENCY = 10
          var probeQueue = []
          var probeRunning = 0
          var probeKickTimer = null

          function pumpProbeQueue() {
            while (probeRunning < PROBE_CONCURRENCY && probeQueue.length) {
              /**
               * 🔴 这里必须用 IIFE 把 task 锁进闭包作用域，**不能用 `var task = shift()`**。
               *
               * 踩过的坑：原来写的是
               *     var task = probeQueue.shift()
               *     probeKid(task.folderId).then(function (has) {
               *       applyProbeResult(task.parentId, task.folderId, has)   // ← 读的是最后一次的 task
               *     })
               * `var` 是函数作用域，while 循环里每一轮赋的都是同一个变量。于是**所有**
               * 异步回调读到的都是循环结束时那个 task —— 9 个目录的探测结果全写到了
               * 最后那个文件夹头上，其余 8 个永远停在「未知」。
               *
               * 表现：树里只有 1~2 个三角标，等多久都不补齐。
               */
              ;(function (task) {
                probeRunning += 1
                probeKid(task.folderId)
                  .then(function (has) {
                    applyProbeResult(task.parentId, task.folderId, has)
                  })
                  .catch(function () {
                    /* probeKid 自己已经吞掉错误了，这里只是兜底 */
                  })
                  .then(function () {
                    probeRunning -= 1
                    pumpProbeQueue()
                  })
              }(probeQueue.shift()))
            }
          }

          function applyProbeResult(parentIdValue, folderId, has) {
            if (has === null || has === undefined) return
            setTreeRoot(function (current) {
              return replaceTreeNode(current, parentIdValue, function (node) {
                var kids = node.children || []
                var changed = false
                var next = kids.map(function (kid) {
                  if (kid.id !== folderId) return kid
                  if (kid.hasKids === has) return kid
                  changed = true
                  return Object.assign({}, kid, { hasKids: has })
                })
                if (!changed) return node
                return Object.assign({}, node, { children: next })
              })
            })
          }

          function probeTreeKids(parentIdValue, folders) {
            var now = Date.now()
            var targets = folders.slice(0, 30).filter(function (folder) {
              if (!folder || !folder.id) return false
              var cached = kidProbeCache[folder.id]
              // 没探过、或者缓存过期了，都要重新探
              return cached === undefined || now - cached.at >= KID_PROBE_TTL_MS
            })
            if (!targets.length) return
            for (var i = 0; i < targets.length; i += 1) {
              probeQueue.push({ parentId: parentIdValue, folderId: targets[i].id })
            }
            /**
             * 下一帧就开始，不拖。
             *
             * 用 setTimeout(0) 而不是同步 pump：让当前这一帧的渲染（把子目录画出来）
             * 先提交完，再发请求 —— 否则十几个请求会在同一次渲染里挤着发出去。
             * 但**绝不延迟到秒级**：那正是「三角标半天不出来」的原因。
             */
            if (probeKickTimer === null) {
              probeKickTimer = setTimeout(function () {
                probeKickTimer = null
                pumpProbeQueue()
              }, 0)
            } else {
              pumpProbeQueue()
            }
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
            if (!hit) return
            if (hit.node.loading) return
            // 节流：刚失败过的目录别立刻再打一次（界面会抖，请求也白费）。
            var now = Date.now()
            var lastTry = Number(treeLoadTryAt.current[id]) || 0
            var fails = Number(treeFailCount.current[id]) || 0
            if (!cursor && fails > 0 && now - lastTry < Math.min(30_000, 1000 * Math.pow(2, fails - 1))) {
              return
            }
            treeLoadTryAt.current[id] = now
            var appending = !!cursor
            setTreeRoot(function (current) {
              return replaceTreeNode(current, id, function (node) {
                return Object.assign({}, node, { loading: true })
              })
            })
            /**
             * 清缓存再拉：树是「用户刚点了刷新 / 刚传完文件」才走到这里的，
             * 沿用客户端 5 分钟缓存会让树看起来完全没更新。
             */
            // 树是「用户刚点了刷新 / 刚传完文件」才走到这里的，必须拉最新的。
            api.list(id, cursor || '', undefined, { force: true })
              .then(function (doc) {
                if (!doc || doc.ok === false) throw new Error((doc && doc.error) || 'load failed')
                var rows = Array.isArray(doc.items) ? doc.items : []
                var folders = rows.filter(function (row) {
                  return row.type === 'folder'
                })
                // 这次列表本身就回答了「这个目录有没有子文件夹」，记进探测缓存。
                if (!cursor) rememberListing(id, rows)
                var more = doc.nextCursor ? String(doc.nextCursor) : ''
                // 空目录：把 open 收回 false，并且记下「确实没有下级」，
                // 这样用户点了一下之后箭头不会留着、也不会再显示。
                //
                // ⚠️ 但「空」不能是因为**还没写完**。刚传完文件再拉列表时，
                // 服务端有可能会先回一页空结果（索引滞后），这时候如果把
                // children 清空，树就真的塌成只剩一个 / 了。所以：
                // 只有在「本来就没子节点」或者「连续两次都拉到空的」时才清。
                var isEmpty = folders.length === 0 && !more
                var emptyStreak = isEmpty ? (Number(treeFailCount.current[id + '|empty']) || 0) + 1 : 0
                treeFailCount.current[id + '|empty'] = emptyStreak
                treeFailCount.current[id] = 0
                /**
                 * 这一次的「空」是否可疑：之前明明有子节点，但第一回就拉到了空。
                 * ⚠️ 必须在上一次 state 的 updater 里判断 —— 外面拿到的 hit 是
                 * 发起请求那一刻的快照，children 可能已经变了。
                 */
                var suspicious = { value: false }
                setTreeRoot(function (current) {
                  return replaceTreeNode(current, id, function (node) {
                    var previous = node.children || []
                    if (isEmpty && previous.length > 0 && emptyStreak < 2) {
                      suspicious.value = true
                      // 这一次的空结果不可信：原样留着旧子节点，只把 loading 放掉。
                      return Object.assign({}, node, { loading: false })
                    }
                    if (isEmpty) kidProbeCache[id] = { has: false, at: Date.now() }
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
                      /**
                       * 拉到子文件夹就**明确**记成 true。
                       *
                       * 🔴 这里以前写的是 `isEmpty ? false : node.hasKids` —— 非空时
                       * 把原来的 null 原样保留。旧版本因为「null 也当有下级画箭头」，
                       * 这个漏洞被掩盖了；改成「未知不画三角标」之后它立刻现形：
                       * 明明有 9 个子文件夹的根节点，`hasKids` 一直是 null，
                       * 于是三角标不出现、只剩一个淡点。
                       *
                       * 判据就是「这一页里有没有文件夹」——有就一定能展开。
                       */
                      hasKids: isEmpty ? false : true,
                    })
                  })
                })
                if (suspicious.value) {
                  // 空结果先不信：400ms 后再问一次，第二次还是空才认。
                  try {
                    setTimeout(function () {
                      treeLoadTryAt.current[id] = 0
                      loadTreeChildren(id)
                    }, 400)
                  } catch (failure) {
                    logWarn('schedule tree recheck failed', failure)
                  }
                  return
                }
                // 子列表到位后，顺手探测「哪些子目录还有下一级」。
                //
                // 0.4.0：由于「未知也先画箭头」，这里探测的用途变了 —— 它不再是
                // 「把箭头一个个补出来」，而是「把空目录的箭头收回去」，所以慢一点没关系
                // （probeTreeKids 里已经压到并发 2 且延后 200ms）。
                if (!appending) {
                  if (folders.length > 0) {
                    probeTreeKids(id, folders)
                  } else if (more) {
                    // 这一页全是文件、但还有下一页：说明「有没有子文件夹」还没定论。
                    // 把这一层自己再探一次（pageSize=50 一次就够），别让箭头一直挂着。
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
                }
              })
              .catch(function (failure) {
                logWarn('tree load failed', failure)
                treeFailCount.current[id] = fails + 1
                setTreeRoot(function (current) {
                  return replaceTreeNode(current, id, function (node) {
                    // ⚠️ 失败时**不要清 children**：清掉的话树会在网络抖动的瞬间
                    // 从「一堆文件夹」变成「只剩一个 /」，跟用户报的现象一模一样。
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

          /**
           * 目录变化 / 树被作废之后，把左树补齐。
           *
           * 🔴 这里就是「刷新之后树只剩一个 /」那条 bug 的修复点。
           *
           * 旧实现只依赖 `[parentId, authorized]`：
           *   · 在根目录点「刷新」→ parentId 还是 '/'，effect 不重跑；
           *   · 而 invalidateTreeKnowledge 又把根节点的 children 清空了 →
           *     树里永远只剩一个 `/`，除非用户先点进别的目录再退回来。
           * 「上传文件有概率触发」也是同一条链：上传完 runMutation/刷新会作废树，
           * 如果那时正好在根目录，就卡成只剩一个 /。
           *
           * 现在依赖里加上了 treeEpoch（作废时 +1）。另外补一层「谁来兜底」：
           * 只要发现当前节点 `loaded === false` 且不在加载中，就重新拉一次 ——
           * 这样任何一个 branch 忘了自己触发加载，树也一定会自己长回来。
           * 重试间隔由 loadTreeChildren 里的节流控制，不会打爆接口。
           */
          React.useEffect(function () {
            if (!authorized) return
            syncTreeToStack()
            // 根节点：没加载过、也没在加载，就拉一次。
            if (!treeRoot.loaded && !treeRoot.loading) loadTreeChildren('/')
            // 当前路径上的每一级：展开 + 需要时补拉。
            stack.forEach(function (entry) {
              if (!entry || !entry.id) return
              var hit = findTreeNode(entry.id)
              if (!hit) return
              if (!hit.node.open) {
                var targetId = entry.id
                setTreeRoot(function (current) {
                  return replaceTreeNode(current, targetId, function (node) {
                    return Object.assign({}, node, { open: true })
                  })
                })
              }
              if (!hit.node.loaded && !hit.node.loading) loadTreeChildren(entry.id)
            })
          }, [parentId, authorized, treeEpoch, treeRoot.loaded, treeRoot.loading, stack.length])

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
            showNotice(t('downloadDirSaved'), NOTICE_LINGER_MS)
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

          /**
           * 重命名（0.4.4 第 7 条修复）。
           *
           * 🔴 老实现用的是 `window.prompt(...)`。**Electron 不支持 window.prompt** ——
           * 它没有实现这个方法，调用会抛错或直接返回 null。于是：
           *
           *     var next = window.prompt(t('renamePrompt'), item.name)
           *     if (next === null) return        // ← 永远走这里
           *
           * 表现就是用户说的「文件夹命名无效」：右键点重命名，什么都没发生，
           * 也没有任何报错（异常被 try/catch 吞掉了）。
           *
           * 现在改成面板内的输入框（和「新建文件夹」那条一样的形态），
           * 绝不依赖浏览器原生的 prompt / confirm 对话框。
           */
          function renameEntry(item) {
            if (!item || !item.id) return
            setRenameTarget(item)
            setRenameDraft(String(item.name || ''))
            setRenameError('')
          }

          function closeRenameModal() {
            setRenameTarget(null)
            setRenameDraft('')
            setRenameError('')
          }

          function submitRename() {
            var item = renameTarget
            if (!item || !item.id || busy) return
            var next = String(renameDraft || '').trim()
            if (!next) {
              setRenameError(t('renameEmpty'))
              return
            }
            if (next === String(item.name || '')) {
              closeRenameModal()
              return
            }
            runMutation(function () {
              return api.rename(item.id, next)
            }).then(function (result) {
              if (result === null) {
                // 失败时把弹层留着，让用户改个名字再试（banner 里已经是宿主的原因）
                setRenameError(t('renameFailed'))
                return
              }
              closeRenameModal()
              showNotice(t('renameDone', { name: next }), NOTICE_LINGER_MS)
            })
          }

          function renderRenameModal() {
            if (!renameTarget) return null
            var overlay = h('div', {
              className: 'mc-overlay',
              onMouseDown: function (event) {
                if (event && event.target !== event.currentTarget) return
                closeRenameModal()
              },
            },
              h('div', { className: 'mc-panel', role: 'dialog', 'aria-modal': 'true' },
                h('div', { className: 'mc-panelHead' },
                  h('h2', { className: 'mc-panelTitle' }, t('rename')),
                  h('button', {
                    type: 'button',
                    className: 'mc-btn mc-panelClose',
                    title: t('close'),
                    'aria-label': t('close'),
                    onClick: closeRenameModal,
                  }, '✕')
                ),
                h('p', { className: 'mc-hint' }, t('renameHint', { name: renameTarget.name })),
                h('div', { className: 'mc-exModalRow' },
                  h('input', {
                    className: 'mc-input',
                    type: 'text',
                    autoFocus: true,
                    spellCheck: false,
                    autoComplete: 'off',
                    value: renameDraft,
                    placeholder: t('renamePrompt'),
                    'aria-label': t('renamePrompt'),
                    onChange: function (event) { setRenameDraft(event.target.value) },
                    onKeyDown: function (event) {
                      if (event.key === 'Enter') submitRename()
                      if (event.key === 'Escape') closeRenameModal()
                    },
                  })
                ),
                renameError ? h('div', { className: 'mc-banner mc-bannerErr' }, renameError) : null,
                h('div', { className: 'mc-panelFoot' },
                  h('button', {
                    type: 'button',
                    className: 'mc-btn mc-btnPrimary',
                    disabled: busy || !String(renameDraft || '').trim(),
                    onClick: submitRename,
                  }, busy ? t('loading') : t('save')),
                  h('button', { type: 'button', className: 'mc-btn', onClick: closeRenameModal }, t('cancel'))
                )
              )
            )
            return portalToBody(overlay)
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
            showNotice(t('pathCopied', { path: path }), NOTICE_LINGER_MS)
            copyTextToClipboard(path).then(function () {
              showNotice(t('pathCopied', { path: path }), NOTICE_LINGER_MS)
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

          /**
           * 删除选中的多项（0.4.4 第 5 条）。
           *
           * 后端 `/remove` 本来就接受数组（走 recyclebin/batchTrash，是进回收站，
           * 不是永久删除），所以一次请求就够，不需要循环。
           * 删除完把选中集合清掉 —— 否则选中态还挂着一些已经不存在的 id。
           */
          function removeSelected() {
            var targets = selectedItems()
            if (!targets.length) return
            if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
              if (!window.confirm(t('multiRemoveConfirm', { count: targets.length }))) return
            }
            runMutation(function () {
              return api.remove(targets.map(function (entry) { return entry.id }))
            }).then(function (ok) {
              if (ok === null) return
              clearSelection()
              showNotice(t('multiRemoveDone', { count: targets.length }), NOTICE_LINGER_MS)
            })
          }

          /** 转移选中的多项（0.4.4 第 5 条）：走同一个转移面板，只是源是一组。 */
          function moveSelected() {
            var targets = selectedItems()
            if (!targets.length) return
            openMovePicker(targets)
          }

          // ------------------------------------------------------ 转移（移动）到别的文件夹
          /**
           * 转移面板（0.4.5 第 3 条：**做成首页左侧文件夹那样的树**）。
           *
           * 版本演进，记下来免得再走回去：
           *
           *   0.4.3 及以前：每行都是 <button>，点一下直接进去，只显示当前这一层，
           *                上一级的内容整个消失 → 「点完一级上级就没了」。
           *   0.4.4：改了面包屑 + 双击进入，但**列表仍然只显示当前一层** ——
           *          用户说「不是这种点完一级上级就没了」，指的就是这个。
           *   0.4.5：改成真正的**目录树**，和左上角那个「文件夹」树同一种东西：
           *          · 所有展开过的层级**同时可见**，上级不会消失；
           *          · 三角标收起/展开，和左树完全一致（固定 10px 格子 + SVG 折角）；
           *          · 单击 = 选中为目标，双击 = 展开/收起（不是「跳走」）；
           *          · 底部「转移到这里」用当前选中的那个目录。
           *
           * 树是**懒加载**的：只在用户第一次展开某个节点时才去 list，
           * 和左树一个策略（网盘目录可能很多，一次全拉会卡好几秒）。
           */
          function openMovePicker(itemOrItems) {
            var sources = Array.isArray(itemOrItems)
              ? itemOrItems.filter(function (entry) { return entry && entry.id })
              : (itemOrItems ? [itemOrItems] : [])
            if (!sources.length) return
            setMoveSource(sources.length === 1 ? sources[0] : null)
            setMoveSources(sources.length > 1 ? sources : [])
            setMoveOpen(true)
            setMoveError('')
            // 目标默认是根；树从根开始，根默认展开
            setMoveTargetId('/')
            setMoveTree({
              id: '/',
              name: '/',
              open: true,
              loading: true,
              loaded: false,
              children: [],
            })
            // 拉根这一层；拉完会顺手探测每个子目录有没有下一级（三角标就靠它）
            loadMoveTreeChildren('/')
          }

          function closeMovePicker() {
            setMoveOpen(false)
            setMoveSource(null)
            setMoveSources([])
            setMoveTree(null)
            setMoveTargetId('/')
            setMoveError('')
          }

          /** 把一棵（子）树里所有节点的 loaded 标回 false，保留 children（和左树同一套）。 */
          function markMoveTreeStale(node) {
            if (!node) return node
            var kids = (node.children || []).map(markMoveTreeStale)
            return Object.assign({}, node, { loaded: false, children: kids })
          }

          /** 在转移树里按 id 找节点。 */
          function findMoveTreeNode(id, node) {
            var root = node || moveTree
            if (!root) return null
            if (String(root.id) === String(id)) return root
            var kids = root.children || []
            for (var i = 0; i < kids.length; i += 1) {
              var hit = findMoveTreeNode(id, kids[i])
              if (hit) return hit
            }
            return null
          }

          /** 不可变地替换转移树里某个节点。 */
          function replaceMoveTreeNode(root, id, updater) {
            if (!root) return root
            if (String(root.id) === String(id)) return updater(root)
            var kids = root.children || []
            var changed = false
            var nextKids = kids.map(function (kid) {
              var next = replaceMoveTreeNode(kid, id, updater)
              if (next !== kid) changed = true
              return next
            })
            if (!changed) return root
            var copy = Object.assign({}, root)
            copy.children = nextKids
            return copy
          }

          /**
           * 拉某一层的子目录（只取文件夹，和左树一样）。
           *
           * 失败时**只清 loading，不动 children** —— 否则网络抖一下整棵树会塌掉，
           * 那是左树踩过的坑（见 11.1），这里不重复。
           */
          function loadMoveTreeChildren(id) {
            /**
             * ⚠️ 不要在这里用 findMoveTreeNode(id) 去「确认节点存在」。
             *
             * openMovePicker 是「setMoveTree(根) → loadMoveTreeChildren(根)」这样连着调的，
             * 而 setState 要等到下一次渲染才生效 —— 此刻 moveTree 还是 null，
             * findMoveTreeNode 必然返回 null。如果拿它当守卫，**第一次加载永远被跳过**，
             * 整个树就是空的（这个坑踩过：测试里表现为「转移树里没有『一层』」）。
             *
             * 所以守卫改成「看 loading 标记」：已经在加载就不重复发，其余情况照发。
             */
            var current = findMoveTreeNode(id)
            if (current && current.loading) return Promise.resolve()
            var alreadyLoaded = current && current.loaded
            if (alreadyLoaded) return Promise.resolve()
            setMoveTree(function (tree) {
              if (!tree) return tree
              return replaceMoveTreeNode(tree, id, function (node) {
                return Object.assign({}, node, { loading: true })
              })
            })
            return api.list(id, '', undefined, { force: true })
              .then(function (doc) {
                var rows = Array.isArray(doc.items) ? doc.items : []
                var folders = rows.filter(function (row) { return row && row.type === 'folder' })
                setMoveTree(function (current) {
                  return replaceMoveTreeNode(current, id, function (node) {
                    var previous = node.children || []
                    var mapped = folders.map(function (folder) {
                      var old = null
                      for (var k = 0; k < previous.length; k += 1) {
                        if (String(previous[k].id) === String(folder.id)) { old = previous[k]; break }
                      }
                      return {
                        id: folder.id,
                        name: folder.name,
                        open: old ? old.open : false,
                        loading: false,
                        loaded: old ? old.loaded : false,
                        children: old ? old.children : [],
                        hasKids: old ? old.hasKids : null,
                      }
                    })
                    return Object.assign({}, node, { loading: false, loaded: true, children: mapped })
                  })
                })
                /**
                 * 🔴 0.4.6（用户第 1 条）：「转移面板里只有 / 目录下的文件」。
                 *
                 * 根因就在这儿：子目录建出来时 `hasKids` 是 `null`（未知），而
                 * 渲染那边「未知 → 什么都不画」（这是左树定过的规矩，不能改）。
                 * 结果每个子目录**都没有三角标**，用户根本看不出它还能展开，
                 * 自然以为「只有 / 这一层」。
                 *
                 * 修法和左树完全一样：**拉完一层就顺手探测下一层有没有子文件夹**。
                 * 复用同一个 probeKid（带 45 秒缓存 + in-flight 去重），
                 * 所以回访过的目录零延迟，只有第一次见到的目录才真的问一次。
                 */
                probeMoveKidRows(id, folders)
              })
              .catch(function (failure) {
                logWarn('move tree load failed', failure)
                setMoveTree(function (current) {
                  return replaceMoveTreeNode(current, id, function (node) {
                    return Object.assign({}, node, { loading: false })
                  })
                })
                setMoveError(t('listFailed', { detail: messageOf(failure) }))
              })
          }

          /**
           * 探测一批子目录「有没有下一级」，把结论写回转移树。
           *
           * 复用 `probeKid`（扫描树那套），所以：
           *   · 有 45 秒 TTL，不会每次开面板都重问一遍；
           *   · 同一个目录正在飞就复用那个 promise（in-flight 去重）；
           *   · 任何已经 list 过的目录都会被 `rememberListing` 记下，回访零延迟。
           *
           * 探测结果只写 `hasKids: true/false`；**null（未知）仍然不画三角标**，
           * 和左树一个规矩 —— 不搞「先占位再撤销」。
           */
          function probeMoveKidRows(parentIdValue, folders) {
            if (!folders || !folders.length) return
            var targets = folders.slice(0, 40)
            var chain = Promise.resolve()
            targets.forEach(function (folder) {
              if (!folder || !folder.id) return
              ;(function (target) {
                chain = chain.then(function () {
                  return probeKid(target.id).then(function (has) {
                    if (has === null || has === undefined) return
                    setMoveTree(function (current) {
                      return replaceMoveTreeNode(current, parentIdValue, function (node) {
                        var kids = node.children || []
                        var changed = false
                        var next = kids.map(function (kid) {
                          if (String(kid.id) !== String(target.id)) return kid
                          if (kid.hasKids === has) return kid
                          changed = true
                          return Object.assign({}, kid, { hasKids: has })
                        })
                        if (!changed) return node
                        return Object.assign({}, node, { children: next })
                      })
                    })
                  }).catch(function () {
                    /* 探测失败就当未知，不画三角标，也不缓存 false */
                  })
                })
              }(folder))
            })
            return chain
          }

          /** 点三角标：展开/收起。第一次展开才去拉子目录。 */
          function toggleMoveTreeNode(id) {
            var hit = findMoveTreeNode(id)
            if (!hit) return
            var willOpen = !hit.open
            setMoveTree(function (current) {
              return replaceMoveTreeNode(current, id, function (node) {
                return Object.assign({}, node, { open: willOpen })
              })
            })
            if (willOpen && !hit.loaded) loadMoveTreeChildren(id)
          }

          /** 单击节点 = 把它选成转移目标。 */
          function selectMoveTarget(node) {
            if (!node) return
            setMoveTargetId(String(node.id))
            setMoveError('')
          }

          /** 这次要移动的源项（单选 / 多选统一取）。 */
          function moveSourceList() {
            if (moveSources.length > 0) return moveSources
            return moveSource ? [moveSource] : []
          }

          /** 这次的目标目录 id（默认根）。 */
          function moveTargetIdOf() {
            return moveTargetId || '/'
          }

          /** 目标的显示名（用于底部按钮上的「转移到「X」」）。 */
          function moveTargetName() {
            if (!moveTargetId || moveTargetId === '/') return t('root')
            var hit = findMoveTreeNode(moveTargetId)
            return hit ? hit.name : t('root')
          }

          /**
           * 目标合法性：不能是它自己，也不能是它自己里面的子目录。
           *
           * 后一条用「目标的祖先链里有没有源」判断 —— 树上每个节点的父链可以直接
           * 从树结构里算出来，不用再问一次网盘。
           */
          function moveTargetProblem(targetId) {
            var sources = moveSourceList()
            if (!sources.length) return 'no-source'
            for (var s = 0; s < sources.length; s += 1) {
              if (String(sources[s].id) === String(targetId)) return 'self'
            }
            // 目标若是某个源文件夹的后代，就是「往自己里面搬」
            for (var j = 0; j < sources.length; j += 1) {
              if (sources[j].type !== 'folder') continue
              if (isMoveDescendantOf(String(targetId), String(sources[j].id))) return 'inside'
            }
            return null
          }

          /** targetId 是不是 ancestorId 的后代（在同一条树链上）。 */
          function isMoveDescendantOf(targetId, ancestorId) {
            function walk(node, inside) {
              if (!node) return false
              var here = inside || String(node.id) === String(ancestorId)
              if (here && String(node.id) === String(targetId) && String(node.id) !== String(ancestorId)) {
                return true
              }
              var kids = node.children || []
              for (var i = 0; i < kids.length; i += 1) {
                if (walk(kids[i], here)) return true
              }
              return false
            }
            return walk(moveTree, false)
          }

          function confirmMove() {
            var sources = moveSourceList()
            if (!sources.length) return
            var targetId = moveTargetIdOf()
            var problem = moveTargetProblem(targetId)
            if (problem === 'self') { setMoveError(t('moveSelf')); return }
            if (problem === 'inside') { setMoveError(t('moveInside')); return }
            setMoveBusy(true)
            setMoveError('')
            api.move(sources.map(function (entry) { return entry.id }), targetId)
              .then(function () {
                setMoveBusy(false)
                closeMovePicker()
                // 移动后两边目录都变了：清缓存并刷新当前视图
                clearListingCache()
                clearSelection()
                return reload()
              })
              .catch(function (failure) {
                setMoveBusy(false)
                setMoveError(t('actFailed', { detail: messageOf(failure) }))
                logWarn('move failed', failure)
              })
          }

          /** 转移树的一个节点（递归渲染，和左树同款三角标）。 */
          function renderMoveTreeNode(node, depth) {
            if (!node) return null
            var isRoot = String(node.id) === '/'
            var kids = node.children || []
            var known = node.hasKids
            var hasKids = known === true || kids.length > 0
            var canToggle = known !== false || kids.length > 0
            if (node.loaded && kids.length > 0) {
              hasKids = true
              canToggle = true
            }
            var selected = String(moveTargetId) === String(node.id)
            var blocked = moveTargetProblem(node.id) === 'inside'
            var isSelf = moveTargetProblem(node.id) === 'self'
            var disabled = blocked || isSelf

            return h('div', { key: 'mvtn' + node.id },
              h('div', {
                className: 'mc-exTreeNode mc-mvNode' +
                  (selected ? ' mc-exTreeNodeActive' : '') +
                  (disabled ? ' mc-mvNodeDisabled' : ''),
                style: { paddingLeft: String(depth * 14 + 2) + 'px' },
                title: disabled ? t('moveInside') : node.name,
                onClick: function (event) {
                  if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
                  if (disabled) return
                  selectMoveTarget(node)
                },
                onDoubleClick: function () {
                  if (!canToggle) return
                  toggleMoveTreeNode(node.id)
                },
              },
                h('button', {
                  type: 'button',
                  className: 'mc-exTreeToggle',
                  tabIndex: -1,
                  'aria-label': node.open ? t('collapse') : t('expand'),
                  disabled: !canToggle,
                  onClick: function (event) {
                    event.stopPropagation()
                    if (!canToggle) return
                    toggleMoveTreeNode(node.id)
                  },
                }, renderMoveCaret(node, hasKids)),
                h('span', { className: 'mc-exTreeIcon' }, node.open && kids.length ? '📂' : '📁'),
                h('span', { className: 'mc-exTreeName' }, isRoot ? '/' : node.name),
                isSelf ? h('span', { className: 'mc-moveTag' }, t('moveInside')) : null
              ),
              node.open && kids.length
                ? h('div', { className: 'mc-exTreeKids' },
                    kids.map(function (kid) { return renderMoveTreeNode(kid, depth + 1) })
                  )
                : null
            )
          }

          /** 三角标（和左树同一个视觉：固定格子 + SVG 折角，任何状态不跳宽）。 */
          function renderMoveCaret(node, hasKids) {
            if (node.loading) {
              return h('span', { className: 'mc-exCaretSlot' },
                h('span', { className: 'mc-exTreeSpinner' })
              )
            }
            if (!hasKids) return h('span', { className: 'mc-exCaretSlot' })
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

          function renderMovePicker() {
            if (!moveOpen) return null
            var sources = moveSourceList()
            if (!sources.length) return null
            var targetName = moveTargetName()
            var many = sources.length > 1
            var overlay = h('div', {
              className: 'mc-overlay',
              onMouseDown: function (event) {
                if (event && event.target === event.currentTarget) closeMovePicker()
              },
            },
              h('div', { className: 'mc-panel mc-movePanel', role: 'dialog', 'aria-modal': 'true' },
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
                h('p', { className: 'mc-hint' }, many
                  ? t('moveMultiSource', { count: sources.length })
                  : t('moveSource', { name: sources[0].name })),
                moveError ? h('div', { className: 'mc-banner mc-bannerErr' }, moveError) : null,
                // 目录树：所有展开过的层级同时在，上级不会消失
                h('div', { className: 'mc-mvTreeWrap' },
                  h('div', { className: 'mc-mvTreeHead' },
                    h('span', {}, t('folders')),
                    h('span', { className: 'mc-mvTreeTarget', title: targetName }, targetName)
                  ),
                  h('div', { className: 'mc-mvTreeScroll' },
                    moveTree
                      ? renderMoveTreeNode(moveTree, 0)
                      : h('div', { className: 'mc-exEmpty' }, t('loading')),
                    // 根下面一个文件夹都没有时的说明
                    moveTree && moveTree.loaded && (moveTree.children || []).length === 0
                      ? h('div', { className: 'mc-exEmpty' }, t('moveNoFolders'))
                      : null
                  )
                ),
                h('div', { className: 'mc-moveFootHint' }, t('moveTreeHint')),
                h('div', { className: 'mc-panelFoot' },
                  h('button', {
                    className: 'mc-btn mc-btnPrimary',
                    disabled: moveBusy,
                    onClick: confirmMove,
                  }, moveBusy
                    ? t('loading')
                    : (many
                      ? t('moveHereMulti', { count: sources.length, name: targetName })
                      : t('moveHere', { name: targetName }))),
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

          // ------------------------------------------------------ 传输记录弹层（分页）
          /** 弹层是否开着（轮询里要判断，所以用 ref 而不是直接读 state）。 */
          var historyOpenRef = React.useRef(false)
          React.useEffect(function () {
            historyOpenRef.current = historyOpen
          }, [historyOpen])

          function historyStateFor(family) {
            return family === 'upload' ? historyUpload : historyDownload
          }

          function setHistoryStateFor(family, next) {
            if (family === 'upload') setHistoryUpload(next)
            else setHistoryDownload(next)
          }

          function patchHistoryState(family, patch) {
            setHistoryStateFor(family, Object.assign({}, historyStateFor(family), patch))
          }

          /**
           * 拉一页传输记录。
           *
           * family: 'upload' | 'download'
           * append: true = 接在已有记录后面（「加载更多」），false = 从第一页重拉。
           *
           * 记录永不删除，所以 total 可能很大；界面只渲染已经拉下来的部分，
           * 「加载更多」按 offset 往后翻。
           */
          function loadHistoryPage(family, append) {
            var current = historyStateFor(family)
            if (current.loading) return Promise.resolve(current)
            var offset = append ? current.items.length : 0
            patchHistoryState(family, { loading: true, error: '' })
            return api
              .transfers({ family: family, offset: offset, limit: TRANSFER_PAGE_SIZE })
              .then(function (doc) {
                var list = doc && Array.isArray(doc.jobs) ? doc.jobs : []
                var latest = historyStateFor(family)
                var merged = append ? (latest.items || []).concat(list) : list
                setHistoryStateFor(family, {
                  items: merged,
                  total: Number(doc && doc.total) || merged.length,
                  offset: merged.length,
                  loading: false,
                  error: '',
                })
                return merged
              })
              .catch(function (failure) {
                logWarn('history page failed', failure)
                patchHistoryState(family, { loading: false, error: messageOf(failure) })
                return []
              })
          }

          /** 打开弹层：默认落在「下载」页，同时把两个页签都拉一遍（切页签不用等）。 */
          function openHistory() {
            setHistoryOpen(true)
            historyOpenRef.current = true
            // 每次进来清掉上一次的定位提示，免得旧错误挂在新列表上
            showHistoryNotice('', false)
            loadHistoryPage('download', false)
            loadHistoryPage('upload', false)
          }

          function closeHistory() {
            setHistoryOpen(false)
            historyOpenRef.current = false
            showHistoryNotice('', false)
          }

          /** 弹层开着时被轮询顺带刷新：只刷当前页签的第一页，不打断「加载更多」。 */
          function refreshOpenHistoryTab() {
            var family = historyTab === 'upload' ? 'upload' : 'download'
            var current = historyStateFor(family)
            if (current.loading) return
            loadHistoryPage(family, false)
          }

          function switchHistoryTab(family) {
            if (historyTab === family) return
            setHistoryTab(family)
            // 已经拉过就不重复拉，除非上次是空的（可能刚有第一条记录）。
            if (!historyStateFor(family).items.length) loadHistoryPage(family, false)
          }

          /**
           * 「我自己起过的上传任务」——用来判断什么时候该刷新当前目录。
           *
           * 🔴 0.4.1 修的是这个：以前靠「上一轮看到 running、这一轮看到 done」来判定，
           * 只有满足这个前后对比才会 reload()。可是小文件传得飞快 —— 第一次拉任务列表时
           * 它**已经是 done 了**，于是 uploadFinished 永远是 false，reload() 一次都没跑过。
           *
           * 表现就是用户说的「上传完要过很久（或者手动刷新）才出现」。
           * 现在改成：起任务时把这个 jobId 记进来，轮询里只要看到它到了终态，
           * 就刷新一次并把它移出名单 —— 不管我们有没有在中间看到过 running。
           */
          var watchedUploadJobsRef = React.useRef(Object.create(null))

          function watchUploadJob(jobId) {
            var id = jobId === null || jobId === undefined ? '' : String(jobId)
            if (id) watchedUploadJobsRef.current[id] = true
          }
          function fetchTransfers() {
            return api.transfers({ limit: TRANSFER_POLL_LIMIT })
              .then(function (doc) {
                var list = doc && Array.isArray(doc.jobs) ? doc.jobs : []
                var previous = jobsRef.current || []
                /**
                 * 要不要重拉当前目录？
                 *
                 * 两个来源，任一成立就刷：
                 *   1. 我们自己起过、并且**还没汇报过结果**的上传任务到了终态
                 *      （不管中间有没有观察到 running —— 这才是小文件被漏掉的原因）；
                 *   2. 兜底：上一轮 running、这一轮 done 的上传任务。
                 */
                var watched = watchedUploadJobsRef.current
                var uploadFinished = false
                for (var i = 0; i < list.length; i += 1) {
                  var job = list[i]
                  if (!job || !job.id) continue
                  if (String(job.kind || '').indexOf('upload') !== 0) continue
                  var settled = job.state === 'done' || job.state === 'error' ||
                    job.state === 'cancelled' || job.state === 'canceled'
                  if (watched[job.id] && settled) {
                    delete watched[job.id]
                    // 失败的不刷（目录里不会多出东西，白打一次请求）
                    if (job.state === 'done') uploadFinished = true
                    continue
                  }
                  if (job.state === 'done') {
                    var before = jobById(previous, job.id)
                    if (before && before.state === 'running') uploadFinished = true
                  }
                }
                applyJobs(list)
                // 盯着的那个任务到终态了 → 把「已开始」换成「已完成 / 已失败」，5 秒后消失。
                var pending = pendingNoticeRef.current
                if (pending) settleJobNotice(jobById(list, pending.jobId))
                if (hasRunningJob(list)) ensureTransferPolling()
                else stopTransferPolling()
                // 上传落地后当前目录里才会多出这个文件，刷新一次列表。
                //
                // ⚠️ 这里的 reload() 走的是 /list?refresh=1（见 api.list 的注释），
                // 所以无论宿主是新版还是旧版，都会真的去问一次网盘，不会读到 60 秒缓存。
                if (uploadFinished) reload()
                // 弹层开着就顺手刷一页，让用户看到新记录。
                if (historyOpenRef.current) refreshOpenHistoryTab()
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
           *
           * texts = { started, done, failed }：三条文案都由调用方给好。
           * 「已开始」立刻显示；「已完成 / 已失败」要等轮询看到任务终态才换上去
           * （见 settleJobNotice），并挂 5 秒后自动消失。
           */
          function startJob(key, texts, factory) {
            setJobBusy(key)
            setListError('')
            showNotice('')
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
                // 先把「已开始」显示出来；jobId 拿不到就当这次不跟踪结局。
                showNotice(texts && texts.started ? texts.started : '')
                var jobId = doc && doc.jobId !== undefined && doc.jobId !== null ? String(doc.jobId) : ''
                if (jobId) {
                  watchJobNotice(jobId, texts)
                  // 上传类任务还要盯「它落地了没有」，好把当前目录刷出来。
                  if (String(key || '').indexOf('upload') === 0) watchUploadJob(jobId)
                }
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
            var name = item.name
            return startJob(item.id, {
              started: t('downloadStarted', { name: name }),
              done: t('downloadDone', { name: name }),
              failed: t('downloadFailed', { name: name }),
            }, function () {
              // 把网盘里的文件名一起给 Host：默认落点要用它，而不是 fileId。
              return api.download(item.id, localPath, name)
            })
          }

          /**
           * 下载整个文件夹（0.4.0）。
           *
           * 走服务端打包（跟网页端一致）：Host 调 /file/archiveFiles 让服务端打成 zip，
           * 再把那个 zip 流式下到本地。打包不可用时 Host 会自动回落成逐个文件下载，
           * 所以这里只发一次请求，不需要界面操心走哪条路。
           *
           * 二次确认保留：打包 + 下载大目录可能很慢，先让用户知道。
           */
          function downloadFolder(item) {
            if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
              if (!window.confirm(t('confirmDownloadFolder', { name: item.name }))) return null
            }
            var localDir = joinPath(downloadDir, item.name)
            var name = item.name
            return startJob(item.id, {
              started: t('downloadFolderStarted', { name: name }),
              done: t('downloadDone', { name: name }),
              failed: t('downloadFailed', { name: name }),
            }, function () {
              return api.downloadFolder(item.id, localDir, name)
            })
          }

          function startUpload() {
            var localPath = uploadPath.trim()
            if (!localPath) return null
            var name = baseName(localPath)
            return startJob('upload', {
              started: t('uploadStarted', { name: name }),
              done: t('uploadDone', { name: name }),
              failed: t('uploadFailed', { name: name }),
            }, function () {
              return api.upload(localPath, parentId, '', currentDirPath()).then(function (doc) {
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
                showNotice(t('pickCancelled'), NOTICE_LINGER_MS)
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
                showNotice(t('noFilesSelected'), NOTICE_LINGER_MS)
                return
              }
              showNotice('')
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
            showNotice('')
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
            showNotice(t('uploadFolderStarted', { name: folderName }), NOTICE_LINGER_MS)
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
                // 目录已经由 mkdirPath 建好了，所以这里传 '' 而不是 dir，
                // 免得每传一个文件又去问一次 /mkdir-path。
                uploads = uploads.then(function () { return uploadDroppedFile(file, parent, '') })
              })
              return uploads
            })
            return chain
              .then(function () {
                showNotice(t('uploadFolderDone', { name: folderName, count: files.length }), NOTICE_LINGER_MS)
                return refreshAfterUpload()
              })
              .catch(function (failure) {
                setListError(t('uploadFolderFailed', { detail: messageOf(failure) }))
                logWarn('folder upload failed', failure)
                return null
              })
          }

          // ------------------------------------------------------ 投放到右侧文件区
          /**
           * 打开面板的逻辑已经删掉了（0.3.5）：拖拽直接投到右侧文件区。
           * 这两个函数名保留下来只是为了让「收起拖拽态」这件事有个统一入口。
           */
          function resetDragState() {
            dragDepthRef.current = 0
            setDragOver(false)
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

          // ------------------------------------------------------ 拖入文件夹（0.4.4）
          /**
           * 🔴 0.4.4 第 1 条：支持把**文件夹**直接拖进来上传。
           *
           * 以前只能拖文件，拖文件夹会被礼貌拒绝（提示改用「上传文件夹…」）。
           * 现在按 Chromium 的 File and Directory Entries API 递归展开：
           *
           *   dataTransfer.items[i].webkitGetAsEntry()
           *     → FileSystemDirectoryEntry
           *     → createReader().readEntries()   （一次最多返回 100 条，要循环到空）
           *     → 子目录继续递归 / 文件 entry.file() 拿 File
           *
           * 拿到的 File **没有** `webkitRelativePath`（那是 <input webkitdirectory>
           * 才有的），所以这里自己维护一个相对路径 `dir`，后面建远端目录时用它。
           *
           * ⚠️ 两个必须注意的点：
           *   · `readEntries()` 单次最多给 100 条，只在第一次调用时能拿到 ——
           *     不循环就会「文件夹里只上传了前 100 个文件」；
           *   · 拖进来的目录深度可能很深，加个上限防止软链接环把内存撑爆。
           */
          var DROP_MAX_DEPTH = 24
          var DROP_MAX_FILES = 20_000

          /** 把一个目录的 entries 全部读出来（readEntries 每次最多 100 条）。 */
          function readAllEntries(directoryEntry) {
            return new Promise(function (resolve, reject) {
              var reader = directoryEntry.createReader()
              var all = []
              var rounds = 0
              function next() {
                rounds += 1
                if (rounds > 500) {
                  resolve(all)
                  return
                }
                reader.readEntries(function (batch) {
                  if (!batch || batch.length === 0) {
                    resolve(all)
                    return
                  }
                  for (var i = 0; i < batch.length; i += 1) all.push(batch[i])
                  next()
                }, reject)
              }
              next()
            })
          }

          /** 递归展开一个 entry，把文件塞进 out（带相对目录）。 */
          function walkDroppedEntry(entry, dir, out, depth) {
            if (!entry) return Promise.resolve()
            if (out.files.length >= DROP_MAX_FILES) return Promise.resolve()
            if (entry.isDirectory) {
              if (depth >= DROP_MAX_DEPTH) return Promise.resolve()
              var childDir = dir ? dir + '/' + entry.name : entry.name
              out.dirs.push(childDir)
              if (typeof entry.createReader !== 'function') return Promise.resolve()
              return readAllEntries(entry).then(function (children) {
                var chain = Promise.resolve()
                children.forEach(function (child) {
                  chain = chain.then(function () {
                    return walkDroppedEntry(child, childDir, out, depth + 1)
                  })
                })
                return chain
              }).catch(function () {
                /* 某个子目录读不动就跳过它 */
              })
            }
            if (typeof entry.file === 'function') {
              return new Promise(function (resolve) {
                entry.file(function (file) {
                  if (file) out.files.push({ file: file, dir: dir })
                  resolve()
                }, function () {
                  // 单个文件读不到（权限/占用）就跳过，别让整棵树失败
                  resolve()
                })
              })
            }
            return Promise.resolve()
          }

          /**
           * 从一次拖放里收集「文件 + 目录」。
           *
           * 返回 { files:[{file, dir}], dirs:[相对路径], folderCount, refusedFolder }。
           * folderCount > 0 表示这次拖进来确实有目录（提示语要跟着变）。
           */
          function collectDroppedTree(dataTransfer) {
            var items = dataTransfer && dataTransfer.items ? dataTransfer.items : null
            var entries = []
            var refusedFolder = false
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
                  entries.push(entry)
                  continue
                }
                // 老浏览器没有 entry API（或者 entry 不完整）：只能当文件用
                var file = typeof item.getAsFile === 'function' ? item.getAsFile() : null
                if (file) {
                  if (looksLikeFolder(file)) {
                    refusedFolder = true
                    continue
                  }
                  /**
                   * 🔴 即使有 entry，只要它**没有 .file()**，也要用 getAsFile() 拿到的
                   * File 包一个可用的条目 —— 否则「拖了文件却什么都没上传」。
                   */
                  entries.push({
                    isFile: true,
                    name: file.name,
                    file: function (cb) { cb(file) },
                  })
                  continue
                }
                if (entry && typeof entry.file === 'function') entries.push(entry)
              }
            }

            if (!entries.length) {
              var plain = dataTransfer && dataTransfer.files ? dataTransfer.files : null
              if (plain && plain.length) {
                for (var j = 0; j < plain.length; j += 1) {
                  var one = plain[j]
                  if (!one) continue
                  if (looksLikeFolder(one)) {
                    refusedFolder = true
                    continue
                  }
                  entries.push({ isFile: true, name: one.name, file: function (cb) { cb(one) } })
                }
              }
            }

            var out = { files: [], dirs: [] }
            var folderCount = 0
            var chain = Promise.resolve()
            entries.forEach(function (entry) {
              chain = chain.then(function () {
                if (entry && entry.isDirectory) folderCount += 1
                return walkDroppedEntry(entry, '', out, 0)
              })
            })
            return chain.then(function () {
              return {
                files: out.files,
                dirs: out.dirs,
                folderCount: folderCount,
                refusedFolder: refusedFolder,
              }
            })
          }

          /**
           * ⚠️ 0.4.4 起 `collectDroppedFiles` 已经删掉了。
           *
           * 它原来的职责是「只挑文件、文件夹一律拒绝」，已经被 `collectDroppedTree`
           * 完全取代（后者会递归展开目录）。留着会让下一个人以为拖文件夹还是被拒的。
           */

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
           *
           * dir（可选）= 它在被拖进来的那棵目录树里的相对路径（空 = 当前目录）。
           * 拖文件夹上传时会用到，普通文件上传不传。
           */
          function uploadDroppedFile(file, targetParentId, dir) {
            var id = urlSeqRef.current + 1
            urlSeqRef.current = id
            var name = file && file.name ? String(file.name) : 'upload.bin'
            var relDir = typeof dir === 'string' ? dir : ''
            var label = relDir ? relDir + '/' + name : name
            pushUrlItem({ id: id, name: label, percent: 0, state: 'uploading' })
            setJobBusy('drop')
            // 文件要落到自己在远端的那一层目录里，不是一个都堆在当前目录
            var parentPromise = relDir && typeof api.mkdirPath === 'function'
              ? api.mkdirPath(targetParentId, relDir).then(function (doc) {
                  var id2 = doc && doc.fileId !== undefined && doc.fileId !== null ? doc.fileId : null
                  if (id2 === null) throw new Error('mkdir-path 没有返回 fileId')
                  return id2
                })
              : Promise.resolve(targetParentId)
            return parentPromise
              .then(function (remoteParent) {
                return api.uploadBody(file, remoteParent, function (percent) {
                  updateUrlItem(id, { percent: percent })
                }, currentDirPath())
              })
              .then(function (doc) {
                setJobBusy('')
                updateUrlItem(id, { percent: 100, state: 'done' })
                showNotice(t('urlUploadDone', { name: label }), NOTICE_LINGER_MS)
                scheduleUrlItemDrop(id)
                /**
                 * 🔴 关键：把 Host 返回的 jobId 记进「我要盯的上传任务」。
                 *
                 * /upload-body 传完字节后只回 { jobId } —— 真正的落盘在那之后才完成。
                 * 不记下来的话，轮询里就认不出「这条是我起的、它刚刚完成了」，
                 * 于是永远不会 reload()，用户要等很久或者手动刷新才看到文件。
                 */
                if (doc && doc.jobId) watchUploadJob(doc.jobId)
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

          /**
           * 拖进来的东西按顺序一个一个传（不并发，进度条也看得清）。
           *
           * 🔴 0.4.1：**第一件事必须是拦事件**。
           *
           * DSH 自己在 `document` 上注册了 dragenter / dragover / dragleave / drop
           * （见 dsh-client-ui-attachment 的 registerFileDrop），用来把拖进来的文件
           * 变成对话附件。只 preventDefault 是不够的 —— 那只是不让浏览器去做默认动作
           * （比如导航到那个文件），事件**照样会往 document 冒泡**。
           *
           * 所以之前的表现是：文件既被插件上传了，又出现在对话的附件里。
           * 用 stopPropagation 在插件这一层就把事件掐断，document 上的监听器就收不到了。
           *
           * ⚠️ 只在插件自己的拖放区里拦。插件面板之外、在会话输入框上拖文件，
           * 仍然应该正常变成对话附件 —— 那是 DSH 本来的行为，不能被插件抢掉。
           *
           * 🔴 0.4.4（第 1 条）：文件夹也能拖了。
           * 走 collectDroppedTree 递归展开目录，先按「父先子后」把远端目录建出来
           * （复用 /mkdir-path，同名会复用而不是再建一个），再把每个文件传进它自己那一层。
           */
          function handleDrop(event) {
            stopDragEvent(event)
            resetDragState()
            var dataTransfer = event && event.dataTransfer ? event.dataTransfer : null
            // 目标目录必须在「开始异步展开」之前钉死：展开目录可能要几百毫秒，
            // 期间用户可能已经点进别的目录了。
            var targetParentId = parentId
            var targetPath = currentDirPath()
            setDropNote('')
            setListError('')
            return collectDroppedTree(dataTransfer)
              .then(function (picked) {
                if (!picked.files.length) {
                  // 有目录但里面一个文件都没有 / 完全读不到：说清楚，别静默失败
                  if (picked.folderCount > 0) {
                    setDropNote(t('listDropFolderEmpty'))
                  } else if (picked.refusedFolder) {
                    setDropNote(t('listDropFolder'))
                  }
                  return null
                }
                var first = picked.files[0].dir ? picked.files[0].dir + '/' + picked.files[0].file.name : picked.files[0].file.name
                showNotice(t('uploadStarted', { name: picked.files.length > 1
                  ? first + ' 等 ' + picked.files.length + ' 个文件'
                  : first }), 0)
                if (picked.folderCount > 0) {
                  setDropNote(t('listDropFolderQueued', {
                    count: picked.files.length,
                    path: targetPath,
                  }))
                }
                /**
                 * 先把远端目录按「父先子后」建好，再传文件。
                 *
                 * 为什么不干脆每个文件传之前各自 mkdirPath：
                 *   · 那样建目录的顺序取决于「文件遍历顺序」，可能出现
                 *     「先建 照片/2024、再建 照片」这种倒挂；
                 *   · 同一个目录会被问很多次（/mkdir-path 每次都要列一遍同名检查）；
                 *   · 失败时报错定位也更清楚。
                 *
                 * 先把整棵目录树建完，每个文件就只需要「传到哪个 id」这一个事实。
                 */
                var dirIds = { '': targetParentId }
                var dirs = picked.dirs.slice().sort(function (a, b) {
                  var depthA = a ? a.split('/').length : 0
                  var depthB = b ? b.split('/').length : 0
                  if (depthA !== depthB) return depthA - depthB
                  return a < b ? -1 : (a > b ? 1 : 0)
                })
                var prep = Promise.resolve()
                dirs.forEach(function (dir) {
                  if (!dir) return
                  prep = prep.then(function () {
                    return api.mkdirPath(targetParentId, dir).then(function (doc) {
                      var id = doc && doc.fileId !== undefined && doc.fileId !== null ? doc.fileId : null
                      if (id === null) throw new Error('mkdir-path 没有返回 fileId')
                      dirIds[dir] = id
                    })
                  })
                })
                return prep
                  .then(function () {
                    var chain = Promise.resolve()
                    picked.files.forEach(function (entry) {
                      var parent = dirIds[entry.dir] === undefined ? targetParentId : dirIds[entry.dir]
                      chain = chain.then(function () {
                        // 目录已经建好了，这里不再逐文件重复建（dir 传 ''）
                        return uploadDroppedFile(entry.file, parent, '')
                      })
                    })
                    return chain
                  })
              })
              .catch(function (failure) {
                setListError(t('urlUploadFailed', { detail: messageOf(failure) }))
                logWarn('drop collect failed', failure)
                return null
              })
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
          /**
           * 在光标处开菜单；item 为空 = 列表空白处那一套。
           *
           * 🔴 0.4.4（第 5 条）：右键要尊重当前的选择。
           *
           * 资源管理器的约定：右键点在**已选中的某一项**上 → 菜单针对整个选择；
           * 右键点在**没选中的项**上 → 先把它变成唯一选中，再针对它。
           * 不这么做的话，「多选之后右键」会把选择丢掉，只对那一行生效。
           */
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

            // 右键落在未选中的行上：先切选择，菜单里就是「这一行」
            if (item && item.id && !isSelected(item.id)) {
              setSelectedIds([item.id])
              selectAnchorRef.current = item.id
            }

            // 这一行属于多选集合，而且选了不止一项 → 菜单进入「多选模式」
            var multi = item && item.id && isSelected(item.id) && selectedIds.length > 1
            setMenu({
              x: x,
              y: y,
              item: item || null,
              placed: false,
              count: multi ? selectedIds.length : 0,
            })
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
           * 菜单上的两个上传入口：目标在点下去这一刻定下来（文件行/空白处 = 此刻打开的这个目录）。
           * 之后用户翻目录也不改。
           *
           * ⚠️ 0.3.5 起**没有**「拖动上传」这一项了 —— 拖拽不再是「打开一个面板」，
           * 而是直接把文件松手放到右侧文件区里（见 renderExMain 的投放层）。
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
          }

          function renderMenu() {
            if (!menu) return null
            var items = []
            /**
             * 多选模式（0.4.4 第 5 条）：右键点在「选中集合里的某一行」且集合大于 1。
             *
             * 这时菜单只留「删除选中的 N 项 / 转移选中的 N 项」，以及一条
             * 「取消选择」；单行专属的操作（下载直链、重命名、复制单条路径）
             * 在多选下没有意义，直接不出现 —— 免得用户以为只对一个生效。
             */
            var multiCount = Number(menu.count) || 0
            if (menu.item && multiCount > 1) {
              items.push(menuItem('multi-move', t('menuMultiMove', { count: multiCount }), function () {
                moveSelected()
              }))
              items.push(menuItem(
                'multi-remove',
                t('menuMultiRemove', { count: multiCount }),
                function () { removeSelected() },
                'mc-menuItemDanger',
              ))
              items.push(h('hr', { key: 'menu-sep-multi', className: 'mc-menuSep' }))
              items.push(menuItem('multi-clear', t('clearSelection'), function () { clearSelection() }))
            } else if (menu.item) {
              var item = menu.item
              if (item.type === 'folder') {
                // 文件夹右键（0.4.0）：加回「下载整个文件夹」——
                // 以前这个功能只存在于代码里，菜单里根本没有入口，用户点不到。
                items.push(menuItem('download-folder', t('menuDownloadFolder'), function () {
                  downloadFolder(item)
                }))
                items.push(h('hr', { key: 'menu-sep-folder', className: 'mc-menuSep' }))
                // 进入文件夹靠点名字/双击，增删改移走其他入口。
                items.push(menuItem('copy-path', t('menuCopyPath'), function () { copyItemPath(item) }))
                items.push(menuItem('move', t('menuMove'), function () { openMovePicker(item) }))
                items.push(menuItem('rename', t('menuRename'), function () { renameEntry(item) }))
                items.push(menuItem('remove', t('menuRemove'), function () { removeEntry(item) }, 'mc-menuItemDanger'))
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
              if (selectedIds.length > 0) {
                // 空白处右键也能对现有多选批量操作，和资源管理器一致（选 1 项也给入口）
                items.push(h('hr', { key: 'menu-sep-blank-multi', className: 'mc-menuSep' }))
                items.push(menuItem('multi-move', t('menuMultiMove', { count: selectedIds.length }), function () {
                  moveSelected()
                }))
                items.push(menuItem(
                  'multi-remove',
                  t('menuMultiRemove', { count: selectedIds.length }),
                  function () { removeSelected() },
                  'mc-menuItemDanger',
                ))
                items.push(menuItem('multi-clear', t('clearSelection'), function () { clearSelection() }))
              }
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
              }, multiCount > 1
                ? (t('selectedCount', { count: multiCount }) + '（' + menu.item.name + '）')
                : ((menu.item.type === 'folder' ? '📁 ' : '📄 ') + menu.item.name)) : null,
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
                  openHistory()
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

          /**
           * 第二行：当前路径 + 面包屑 + 搜索（0.4.4 第 4 条）。
           *
           * 用户要求：
           *   · 「新建文件夹」按钮挪到左侧文件夹区（已挪到左树的标题行右侧，见 renderExTree）；
           *   · 原来那个按钮的位置改成「当前路径：」。
           *
           * 所以这一行现在是：`当前路径：` + 可点的面包屑 + 搜索框。
           * 「当前路径：」是一段静态标签（不可点、不参与导航），
           * 真正能点的是它后面那串面包屑 —— 点哪一级回到哪一级。
           */
          function renderExTools() {
            return h('div', { className: 'mc-exTools' },
              h('span', { className: 'mc-exPathLabel', title: currentDirPath() }, t('currentPath')),
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
          /**
           * 三角标格子（固定宽度，任何状态都不跳）。
           *
           * 🔴 只有两种可见状态，**没有「未知占位」这种东西**：
           *   · 有子目录 → 三角标（展开时 rotate 90°）
           *   · 没有 / 还不知道 → 留白
           *
           * 0.4.0 把未知当「有」先画三角标，空文件夹会先长出来再消失；
           * 0.4.2 改成未知画一个淡点，本质还是「先占位再撤销」——
           * 用户两次都否掉了，说「越改越史」。
           *
           * 结论：**未知就老老实实留白，什么都不画。**
           * 探测结果回来之前，这一格看起来就是空的；回来了要是有下级，
           * 三角标自然出现（带一点淡入，不会突兀）。
           *
           * 「等」这件事不再靠 UI 糊弄，而是靠探测够快 + 结果缓存来缩短（见 probeKid）。
           */
          function renderCaret(node, hasKids) {
            // 用户已经点了、正在拉子目录：小转圈（占同样宽度）
            if (node.loading) {
              return h('span', { className: 'mc-exCaretSlot' },
                h('span', { className: 'mc-exTreeSpinner' })
              )
            }
            // 没有子目录，或者还不知道：一律留白。位置永远在，不会跳。
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

            /**
             * 「有没有下一级」是三态：true / false / null（未知）。
             *
             * 🔴 只有两种可见结果，**没有占位符**：
             *   · true  → 三角标
             *   · false → 留白
             *   · null  → 也留白（什么都不画）
             *
             * 这条被否定过两次，别再走回去：
             *   0.4.0 把 null 当「有」先画三角标 → 空文件夹先长出来再消失；
             *   0.4.2 改成 null 画一个淡点 → 本质还是「先占位再撤销」，用户说更糟。
             *
             * 现在：未知就老老实实留白，结果回来自动出现（带 120ms 淡入）。
             * 「等」的时间靠探测够快 + 列表复用（rememberListing）来压，
             * 不靠 UI 糊弄。
             */
            var known = node.hasKids
            var hasKids = known === true
            var canToggle = known !== false
            // 展开过一次并且拿到了子节点，就一定是有下级的
            if (node.loaded && kids.length > 0) {
              hasKids = true
              canToggle = true
            }
            // 0.3.5：刷新会把节点标成 loaded:false 但**保留 children**，
            // 这时上一行不成立，已知的 hasKids 又可能还是 null —— 结果箭头消失。
            // 只要手里还有子节点，就认定它有下级，箭头不该因为一次刷新而不见。
            if (kids.length > 0) {
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
              /**
               * 树头：左边「文件夹」，右边「+ 新建文件夹」（0.4.4 第 4 条）。
               *
               * 用户要求把「新建文件夹」按钮挪到文件夹区域的右侧 —— 就放在这一行，
               * 它本来就贴在左树顶上，和下面的目录列表是同一条视觉动线。
               * 点它会在**当前打开的目录**里建，和右键菜单里的那一项完全等价。
               */
              h('div', { className: 'mc-exTreeHead' },
                h('span', {}, t('folders')),
                h('button', {
                  type: 'button',
                  className: 'mc-exTreeAdd',
                  title: t('newFolderInTree'),
                  'aria-label': t('newFolder'),
                  disabled: busy,
                  onClick: function () {
                    setFolderOpen(true)
                    setFolderName('')
                  },
                }, '+')
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

          /**
           * 资源管理器风格的一行（0.4.4 多选；0.4.5 加了复选框）。
           *
           * 🔴 0.4.5 用户反馈「我怎么没看到多选删除和多选移动功能」——
           * 功能其实在，但**入口完全不可见**：只有按住 Ctrl 点几行才会冒出来。
           * 资源管理器不会让人去猜快捷键，它在每行前面放一个复选框。
           *
           * 所以这里加了复选框列：
           *   · 平时淡一点，鼠标移到行上或该行已选中时变明显（不抢视觉）；
           *   · 点它 = 切换这一行的选中状态（Ctrl 点击那一行的等价物）；
           *   · 全选复选框在列头里（见 renderExMain）。
           */
          function renderExRow(item) {
            var isFolder = item && item.type === 'folder'
            var selected = isSelected(item.id)
            // 搜索结果多带 parentPath，用于告诉用户它在哪
            var where = item.parentPath && item.parentPath !== '/' ? item.parentPath : ''
            return h('div', {
              className: 'mc-exRow' + (selected ? ' mc-exRowSelected' : ''),
              key: item.id,
              title: item.name + (where ? '\n' + where : ''),
              onContextMenu: function (event) { openMenu(event, item) },
              onClick: function (event) { clickRow(item, event) },
              onDoubleClick: isFolder
                ? function () { enterFolder(item) }
                : function () { downloadFile(item) },
            },
              // 第 1 格：名称（左边距已在 CSS 里给足，不再贴左线）
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
              /**
               * 第 2 格：复选框，**紧贴「大小」左边线**（用户要求）。
               *
               * 这一格永远渲染（哪怕未开多选也占位），
               * 否则又会犯 0.4.12 的错：格子数比列数少 → 整行错位。
               */
              h('div', { className: 'mc-exRowCheckCell' },
                multiSelectMode
                  ? h('input', {
                      type: 'checkbox',
                      className: 'mc-exRowCheck',
                      checked: selected,
                      title: t('selectRow'),
                      'aria-label': t('selectRow'),
                      onClick: function (event) {
                        // 别让复选框的点击再冒泡成「点行」——那会把刚选上的又清掉
                        if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
                      },
                      onChange: function () { toggleSelected(item.id) },
                    })
                  : null
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
              className: 'mc-exMain' + (mainNarrow ? ' mc-narrow' : '') + (dragOver ? ' mc-exMainDrop' : '') +
                (multiSelectMode ? ' mc-multiOn' : ''),
              style: colVars,
              ref: mainRef,
              /**
               * 整个右侧区域就是拖放上传的投放面（用户要求）：
               * 「把文件拖到文件夹和名称那一条竖线右边、容量条下面这两个重合的区域内」
               * —— 列头、每一行、空白处都在这个 <main> 里，所以挂在这里一次就全覆盖。
               *
               * 事件必须在这里 preventDefault + stopPropagation：
               *   · preventDefault 才能拿到 drop；
               *   · stopPropagation 才不会被宿主的会话输入框接走（那会变成对话附件）。
               */
              onDragEnter: onDragEnter,
              onDragOver: onDragOver,
              onDragLeave: onDragLeave,
              onDrop: handleDrop,
            },
              /**
               * 列头（0.4.13）：4 个格子，和行完全同构。
               *
               *   [ 名称 1fr ] [ ☑全选 + 多选按钮 ] [ 大小 ] [ 修改时间 ]
               *
               * 第 2 格是「复选框 + 多选按钮」合在一格里，因为它俩要一起
               * **紧贴「大小」左边线**（用户要求）。这一格内容右对齐，
               * 所以最后那个控件就贴着右边线，也就是「大小」那条竖线。
               */
              h('div', {
                className: 'mc-exCols' + (colResizing ? ' mc-exColsResizing' : ''),
                ref: colsRef,
                // 和列表滚动条同宽，保证列头与行的可用宽度一致（否则固定列会错位）
                style: scrollbarW > 0 ? { paddingRight: scrollbarW + 'px' } : undefined,
              },
                h('span', { className: 'mc-exColsName' }, t('colName')),
                // 第 2 格：复选框 + 多选按钮，紧贴「大小」左边线
                /**
                 * 第 2 格：多选按钮 + 复选框，**紧贴「大小」左边线**。
                 *
                 * 🔴 0.4.14 按用户要求**对调**了顺序。
                 *
                 * 0.4.13 是「全选框在前、多选按钮在后」，由于这一格是
                 * `justify-content:flex-end`（靠右对齐），视觉上是
                 *    [ ☑全选 ][ 多选 ]  ← 全选框在左
                 *
                 * 用户要求「点击多选后，多选和多选左边的一键选择框交换位置」，
                 * 也就是让**多选按钮在左、全选框在右**：
                 *    [ 多选 ][ ☑全选 ]
                 *
                 * 好处：按钮的位置固定（贴着左边的那个位置），
                 * 进入多选后全选框从它右侧长出来，按钮本身不会因为
                 * 多了一个控件而被挤着移位。
                 */
                h('div', { className: 'mc-exColsMultiCell' },
                  // ① 多选按钮（靠左）
                  h('button', {
                    type: 'button',
                    className: 'mc-exMultiBtn' + (multiSelectMode ? ' mc-exMultiBtnOn' : ''),
                    title: multiSelectMode ? t('multiExit') : t('multiEnter'),
                    'aria-pressed': multiSelectMode ? 'true' : 'false',
                    onClick: toggleMultiSelectMode,
                  },
                    h('span', { className: 'mc-exMultiIcon' }, multiSelectMode ? '✓' : '☑'),
                    h('span', { className: 'mc-exMultiLabel' }, t('multiBtn'))
                  ),
                  // ② 全选框（靠右，进入多选后才出现）
                  multiSelectMode
                    ? h('input', {
                        type: 'checkbox',
                        className: 'mc-exRowCheck',
                        checked: isAllVisibleSelected(),
                        title: t('selectAll'),
                        'aria-label': t('selectAll'),
                        disabled: (searching ? searchItems : items).length === 0,
                        onChange: toggleSelectAll,
                      })
                    : null
                ),
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
              dropNote ? h('div', { className: 'mc-exBanner mc-exBannerWarn' }, dropNote) : null,
              searchError ? h('div', { className: 'mc-exBanner mc-exBannerErr' }, searchError) : null,
              // 多选提示条（0.4.4 引入；0.4.5 起**选 1 项就出现**）
              //
              // 一开始是「选两项以上才出现」。用户反馈「我怎么没看到多选删除和多选移动」——
              // 勾第一个复选框时界面毫无反应，人根本不知道多选已经生效了。
              // 现在只要选中就出现，动作按钮直接摆在眼前。
              selectedIds.length > 0
                ? h('div', { className: 'mc-exBanner mc-exSelectBar' },
                    h('span', { className: 'mc-exSelectText' },
                      t('selectedCount', { count: selectedIds.length })),
                    h('button', {
                      type: 'button',
                      className: 'mc-btn mc-btnSmall',
                      onClick: moveSelected,
                    }, t('menuMultiMove', { count: selectedIds.length })),
                    h('button', {
                      type: 'button',
                      className: 'mc-btn mc-btnSmall mc-btnDanger',
                      onClick: removeSelected,
                    }, t('menuMultiRemove', { count: selectedIds.length })),
                    h('button', {
                      type: 'button',
                      className: 'mc-btn mc-btnSmall',
                      onClick: clearSelection,
                    }, t('clearSelection'))
                  )
                : null,
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
              ),
              // 拖放蒙层 + 逐文件上行进度卡：都浮在这块区域上，不参与布局
              renderListDropLayer(),
              renderListUploadProgress()
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
           * 历史传输记录弹层（0.4.0 重做）。
           *
           * 用户要求：
           *   1. 分成「上传」「下载」两个页面；
           *   2. 记录**永不删除**（所以去掉了「清空记录」按钮，
           *      改成「打开记录文件所在文件夹」，让用户自己去管理那个文件）。
           *
           * 数据来源是 /transfers?family=upload|download&offset&limit：
           * 宿主把记录持久化在 ~/.dsh-mcloud/transfers.json，重启也不会丢。
           */
          function renderHistoryModal() {
            if (!historyOpen) return null

            var family = historyTab === 'upload' ? 'upload' : 'download'
            var state = historyStateFor(family)
            var rows = (state && Array.isArray(state.items) ? state.items : []).slice()
            // 宿主已经按 startedAt 倒序给了；这里不再排序，避免「加载更多」时前后顺序打架。
            var total = Number(state && state.total) || rows.length
            var hasMore = rows.length < total

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
              var totalBytes = Number(job.total) || 0
              var doneBytes = Number(job.done) || 0
              if (totalBytes > 0) {
                return formatBytes(doneBytes) + ' / ' + formatBytes(totalBytes) +
                  ' · ' + Math.min(100, Math.round((doneBytes / totalBytes) * 100)) + '%'
              }
              return formatBytes(doneBytes)
            }

            /**
             * 这条记录能不能「定位」，以及点了该干什么。
             *
             *   · 下载类（download / download-folder）→ 本机有落点：
             *     交给宿主在资源管理器里选中它（POST /reveal）。
             *   · 上传类（upload / upload-folder）→ 网盘那边有父目录：
             *     把面板切到那个目录，用户就在文件列表里看到它。
             *
             * 传过来之前先看任务里有没有记下位置 —— 老版本留下的记录没有这些字段，
             * 那种就干脆不显示按钮，别给一个点了会报错的入口。
             */
            function revealKindOf(job) {
              var s = String(job && job.kind ? job.kind : '')
              var isUpload = s.indexOf('upload') === 0
              var isDownload = s.indexOf('download') === 0
              if (!isUpload && !isDownload) return ''
              if (isDownload) {
                // 记过本机落点就显示按钮：文件还在 → canRevealLocal=true，点开资源管理器；
                // 文件已经被移走 → canRevealLocal=false，点了明确告诉用户「无法定位」。
                // 完全没记过位置的老记录才不显示（那种点了必然报错，纯粹是坑）。
                return job && job.hasLocalPath ? 'local' : ''
              }
              return job && job.parentFileId ? 'remote' : ''
            }

            /**
             * 定位到网盘里的那个目录（上传记录）。
             *
             * 🔴 0.4.5 第 1 条：**必须重建完整路径，不能再「只放一级、其余退回根」。**
             *
             * 老实现的问题是：上传记录里的 `parentPath` 经常是 null（老记录 / 拖拽上传），
             * 于是这里只能 setStack([]) 退回根目录 —— 照片其实在
             * `/Windows/实验/数字图像实验/第一周实验结果` 里，点「定位」却跳回 `/`，
             * 用户看到的现象就是「传输记录里定位不到上传的图片」。
             *
             * 现在宿主会在 `/transfers/check` 里用 BFS 反查出完整 trail
             * （每一级都带真实 fileId），这里照着把 stack 整条铺出来：
             * 面包屑是完整的，左树也会跟着展开到那一级。
             *
             * 兜底顺序：trail（最准）→ parentPath 字符串拆段（只有名字、没有中间层 id）→ 根。
             */
            function revealRemoteJob(job, located) {
              var parentId = job && job.parentFileId ? String(job.parentFileId) : ''
              if (!parentId) {
                showHistoryNotice(t('revealUnavailable'), true)
                return
              }
              closeHistory()

              // 1) 宿主反查出来的完整 trail：每一级都有 id，直接整条铺
              var trail = located && Array.isArray(located.trail) ? located.trail : null
              if (trail && trail.length) {
                setStack(trail.map(function (entry) {
                  return { id: String(entry.id), name: String(entry.name) }
                }))
                showNotice(t('revealUploadDone', { path: located.path || parentId }), NOTICE_LINGER_MS)
                clearListingCache()
                return
              }

              // 2) 没有 trail：至少把 parentPath 的字面路径铺出来（末级用真实 id）
              if (parentId === parentIdOf()) {
                showNotice(t('revealUploadHere', { path: currentDirPath() }), NOTICE_LINGER_MS)
                clearListingCache()
                reload()
                return
              }
              var path = (located && typeof located.path === 'string' && located.path) ||
                (job && typeof job.parentPath === 'string' ? job.parentPath.trim() : '')
              var segments = path.split('/').filter(function (part) { return part !== '' })
              if (parentId === '/' || segments.length === 0) {
                setStack([])
              } else {
                // 中间层的 id 拿不到，只能铺「末级」这一段（点「/」仍然回得去根）
                setStack([{ id: parentId, name: segments[segments.length - 1] }])
              }
              showNotice(t('revealUploadDone', { path: path || parentId }), NOTICE_LINGER_MS)
              clearListingCache()
            }

            /**
             * 点「定位」（0.4.0，0.4.4 调整提示位置）。
             *
             * 上传记录：先让宿主复核「这个文件还在原来的目录吗」——
             * 用户要求「如果上传的文件移动了位置就显示无法定位」。
             * 下载记录：宿主自己复核本机文件还在不在，不在就回 400 + 明确文案。
             *
             * ⚠️ 宿主是老版本（没有 /transfers/check）时降级：
             *   · 上传记录 → 直接切目录（老宿主只能做到这一步）；
             *   · 下载记录 → 照常调 /reveal，由老宿主的 existsSync 兜底报错。
             * 绝不让用户看到裸的 HTTP 404。
             *
             * 🔴 0.4.4 第 2 条：**失败提示必须显示在传输记录页面里**。
             *
             * 以前这里所有失败都调 showNotice()，而它渲染的是 `.mc-exBanner` ——
             * 那是文件区（列表上方）的横幅，被这个弹层整个盖住。用户看到的现象就是
             * 「定位失败的提示跑到名称下面去了」/根本看不见。
             *
             * 现在失败走 showHistoryNotice()（显示在页签下面、弹层内部），
             * 成功则是「切到网盘目录」这种动作本身能看见结果，仍然用原来的方式。
             */
            function revealJob(job) {
              if (!job || !job.id) return
              var kind = revealKindOf(job)
              showHistoryNotice('', false)
              if (kind !== 'local' && kind !== 'remote') {
                showHistoryNotice(t('revealUnavailable'), true)
                return
              }
              setRevealBusy(job.id)
              if (kind === 'remote') {
                return detectHostCapabilities()
                  .then(function (caps) {
                    // 老宿主没有复核接口：直接切过去，不为难用户。
                    if (!caps.locatable) {
                      setRevealBusy('')
                      revealRemoteJob(job, null)
                      return
                    }
                    return api
                      .checkLocatable(job.id)
                      .then(function (doc) {
                        setRevealBusy('')
                        if (!doc || doc.ok === false || doc.canReveal === false) {
                          showHistoryNotice(t('historyRevealRemoteMoved'), true)
                          return
                        }
                        // 宿主会带回 path / trail，用来铺完整面包屑
                        revealRemoteJob(job, doc)
                      })
                      .catch(function (failure) {
                        setRevealBusy('')
                        logWarn('check locatable failed', failure)
                        showHistoryNotice(messageOf(failure) || t('revealUnavailable'), true)
                      })
                  })
              }
              api.reveal(job.id)
                .then(function (doc) {
                  setRevealBusy('')
                  if (doc && doc.ok === false) {
                    showHistoryNotice(doc.error || t('revealUnavailable'), true)
                    return
                  }
                  // 资源管理器已经被拉起来了，这里不用再刷界面。
                })
                .catch(function (failure) {
                  setRevealBusy('')
                  // 宿主会把「文件已被移动/删除」这种话说清楚，直接用它的文案。
                  var text = messageOf(failure) || t('revealUnavailable')
                  showHistoryNotice(/无法定位|移动|删除/.test(text) ? text : t('historyRevealMoved'), true)
                  logWarn('reveal failed', failure)
                })
            }

            /**
             * 删掉一条传输记录（0.4.7）。
             *
             * 🔴 删的是**记录**，不是文件。确认框里也把这句话写出来了，
             * 免得用户以为点了会把网盘里的文件删掉。
             *
             * 正在跑的任务不允许删：宿主那边会拒，这里先拦一道，
             * 并把原因说清楚（「先取消再删记录」）。
             */
            function removeOneRecord(job) {
              if (!job || !job.id) return
              if (isJobActive(job)) {
                showHistoryNotice(t('historyRemoveRunning'), true)
                return
              }
              if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
                if (!window.confirm(t('historyRemoveOneConfirm', { name: job.label || job.id }))) return
              }
              setHistoryBusy(true)
              showHistoryNotice('', false)
              api.removeTransfer(job.id)
                .then(function () {
                  setHistoryBusy(false)
                  showHistoryNotice(t('historyRemoveOneDone'), false)
                  var current = historyStateFor(family)
                  setHistoryStateFor(family, {
                    items: (current.items || []).filter(function (row) { return row && row.id !== job.id }),
                    total: Math.max(0, (Number(current.total) || 0) - 1),
                    offset: Math.max(0, (Number(current.offset) || 0) - 1),
                    loading: false,
                    error: '',
                  })
                  // 另一页签的计数也跟着少一个，免得页签上的数字对不上
                  var other = family === 'upload' ? 'download' : 'upload'
                  var otherState = historyStateFor(other)
                  if (Array.isArray(otherState.items) && otherState.items.length) {
                    patchHistoryState(other, {
                      items: otherState.items.filter(function (row) { return row && row.id !== job.id }),
                      total: Math.max(0, (Number(otherState.total) || 0) - 1),
                    })
                  }
                  return fetchTransfers()
                })
                .catch(function (failure) {
                  setHistoryBusy(false)
                  showHistoryNotice(messageOf(failure) || t('actFailed', { detail: '' }), true)
                  logWarn('remove transfer record failed', failure)
                })
            }

            /**
             * 一键删掉当前页签的全部记录（0.4.7）。
             *
             * 只删这一个 family（上传页就只删上传记录），另一页不受影响。
             * 同样：只删记录，文件一个都不动。
             */
            function clearCurrentTabRecords() {
              var list = (historyStateFor(family).items || []).filter(function (row) {
                return row && !isJobActive(row)
              })
              if (!list.length) {
                showHistoryNotice(t('historyClearTabNone', { family: familyLabel() }), true)
                return
              }
              if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
                if (!window.confirm(t('historyClearTabConfirm', {
                  count: Number(historyStateFor(family).total) || list.length,
                  family: familyLabel(),
                }))) return
              }
              setHistoryBusy(true)
              showHistoryNotice('', false)
              api.clearTransfers(family)
                .then(function (doc) {
                  setHistoryBusy(false)
                  var removed = Number(doc && doc.removed) || 0
                  showHistoryNotice(t('historyClearTabDone', { count: removed, family: familyLabel() }), false)
                  setHistoryStateFor(family, { items: [], total: 0, offset: 0, loading: false, error: '' })
                  return fetchTransfers()
                })
                .catch(function (failure) {
                  setHistoryBusy(false)
                  showHistoryNotice(messageOf(failure) || t('actFailed', { detail: '' }), true)
                  logWarn('clear transfer records failed', failure)
                })
            }

            /** 当前页签的中文名（给提示文案用）。 */
            function familyLabel() {
              return family === 'upload' ? t('historyFamilyUpload') : t('historyFamilyDownload')
            }

            function renderItem(job) {
              var isErr = job.state === 'error'
              var isDone = job.state === 'done'
              var running = isJobActive(job)
              var totalBytes = Number(job.total) || 0
              var pct = totalBytes > 0 ? Math.min(100, ((Number(job.done) || 0) / totalBytes) * 100) : 0
              var revealKind = isDone || isErr ? revealKindOf(job) : ''
              var revealBusyHere = revealBusy === job.id
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
                  : null,
                /**
                 * 记录底部：左边「定位」，右边「删除这条记录」（0.4.7）。
                 *
                 * 注意「删除」永远有这个按钮（不管有没有定位按钮），
                 * 因为用户清的是记录，跟文件在不在没关系。
                 * 正在跑的任务把按钮置灰，title 里说明先取消。
                 */
                h('div', { className: 'mc-exHistFoot' },
                  revealKind
                    ? h('button', {
                        type: 'button',
                        className: 'mc-exHistReveal',
                        disabled: revealBusyHere,
                        title: revealKind === 'local' ? t('historyRevealDown') : t('historyRevealUp'),
                        onClick: function (event) {
                          if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
                          revealJob(job)
                        },
                      },
                        h('span', { className: 'mc-exHistRevealIcon' },
                          h('svg', { viewBox: '0 0 10 10', width: 9, height: 9, 'aria-hidden': 'true' },
                            h('path', {
                              d: 'M2 5 h6 M5.4 2.4 L8 5 L5.4 7.6',
                              fill: 'none',
                              stroke: 'currentColor',
                              strokeWidth: '1.4',
                              strokeLinecap: 'round',
                              strokeLinejoin: 'round',
                            })
                          )
                        ),
                        revealBusyHere ? t('historyRevealMoving') : t('historyReveal')
                      )
                    : null,
                  h('button', {
                    type: 'button',
                    className: 'mc-exHistRemove',
                    disabled: running || historyBusy,
                    title: running ? t('historyRemoveRunning') : t('historyRemoveOne'),
                    'aria-label': t('historyRemoveOne'),
                    onClick: function (event) {
                      if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
                      removeOneRecord(job)
                    },
                  },
                    h('span', { className: 'mc-exHistRevealIcon' },
                      h('svg', { viewBox: '0 0 10 10', width: 9, height: 9, 'aria-hidden': 'true' },
                        h('path', {
                          d: 'M2.5 2.5 L7.5 7.5 M7.5 2.5 L2.5 7.5',
                          fill: 'none',
                          stroke: 'currentColor',
                          strokeWidth: '1.5',
                          strokeLinecap: 'round',
                        })
                      )
                    ),
                    t('menuRemove')
                  )
                )
              )
            }

            /** 一个页签按钮。 */
            function renderHistoryTab(id, label, count) {
              var active = family === id
              return h('button', {
                key: 'hist-tab-' + id,
                type: 'button',
                role: 'tab',
                'aria-selected': active ? 'true' : 'false',
                className: 'mc-tab mc-exHistTab' + (active ? ' mc-tabActive' : ''),
                onClick: function () { switchHistoryTab(id) },
              }, label + (count > 0 ? ' · ' + count : ''))
            }

            var body
            if (state && state.loading && !rows.length) {
              body = h('div', { className: 'mc-exHistEmpty' }, t('loading'))
            } else if (state && state.error && !rows.length) {
              body = h('div', { className: 'mc-exHistEmpty' }, state.error)
            } else if (!rows.length) {
              body = h('div', { className: 'mc-exHistEmpty' }, t('historyEmpty'))
            } else {
              body = h('div', { className: 'mc-exHistBody' },
                h('div', { className: 'mc-exHistSection' },
                  h('div', { className: 'mc-exHistSectionHead' }, t('historyCount', { count: total })),
                  rows.map(renderItem),
                  hasMore
                    ? h('div', { className: 'mc-exHistMore' },
                        h('button', {
                          type: 'button',
                          className: 'mc-btn mc-btnSmall',
                          disabled: !!(state && state.loading),
                          onClick: function () { loadHistoryPage(family, true) },
                        }, state && state.loading ? t('historyLoadMoreBusy') : t('historyLoadMore'))
                      )
                    : null
                )
              )
            }

            var uploadCount = family === 'upload' ? total : (Number(historyUpload.total) || 0)
            var downloadCount = family === 'download' ? total : (Number(historyDownload.total) || 0)

            return h('div', {
              className: 'mc-overlay',
              onMouseDown: function (event) {
                if (event.target === event.currentTarget) closeHistory()
              },
            }, h('div', { className: 'mc-panel mc-exHistPanel' },
              h('div', { className: 'mc-exModalHead' },
                h('h2', { className: 'mc-exModalTitle' }, t('historyTitle')),
                h('button', {
                  type: 'button',
                  className: 'mc-btn mc-btnSmall mc-panelClose',
                  title: t('cancel'),
                  onClick: function () { closeHistory() },
                }, '×')
              ),
              // 两个页签：上传 / 下载（用户要求分页）
              h('div', { className: 'mc-tabs mc-exHistTabs', role: 'tablist' },
                renderHistoryTab('upload', t('historyTabUpload'), uploadCount),
                renderHistoryTab('download', t('historyTabDownload'), downloadCount)
              ),
              /**
               * 0.4.4 第 2 条：定位失败的理由显示在**这个页面里**。
               *
               * 以前它走的是文件区的 showNotice（.mc-exBanner），被弹层整块盖住，
               * 用户只能看到它在名称下面闪一下。现在这条横幅就在页签正下方，
               * 点完「定位」失败会立刻在这里说明原因（文件被移动/删除、
               * 或者它在网盘里已经不在原位）。
               */
              historyNotice
                ? h('div', {
                    className: 'mc-banner ' + (historyNoticeErr ? 'mc-bannerErr' : 'mc-bannerOk') + ' mc-exHistNotice',
                    role: 'status',
                  },
                    h('span', { className: 'mc-exHistNoticeText', title: historyNotice }, historyNotice),
                    h('button', {
                      type: 'button',
                      className: 'mc-btn mc-btnSmall',
                      title: t('close'),
                      'aria-label': t('close'),
                      onClick: function () { showHistoryNotice('', false) },
                    }, '×')
                  )
                : null,
              body,
              h('div', { className: 'mc-panelFoot mc-exHistFoot2' },
                // 一键删掉**当前页签**的全部记录（0.4.7）：只删记录，不删文件。
                h('button', {
                  type: 'button',
                  className: 'mc-btn mc-btnSmall mc-btnDanger',
                  disabled: historyBusy || total === 0,
                  title: t('historyClearTab', { family: familyLabel() }),
                  onClick: clearCurrentTabRecords,
                }, t('historyClearTab', { family: familyLabel() })),
                h('span', { className: 'mc-exHistFootGap' }),
                h('button', {
                  type: 'button',
                  className: 'mc-btn mc-btnSmall',
                  disabled: historyBusy,
                  title: t('historyOpenFolderHint'),
                  onClick: openTransfersFolder,
                }, t('historyOpenFolder')),
                h('button', {
                  type: 'button',
                  className: 'mc-btn mc-btnSmall',
                  disabled: !!(state && state.loading),
                  onClick: function () { loadHistoryPage(family, false) },
                }, t('refresh'))
              )
            ))
          }

          /** 打开宿主那边存传输记录的文件夹（记录永不删除，用户自己管理）。 */
          function openTransfersFolder() {
            if (historyBusy) return
            setHistoryBusy(true)
            detectHostCapabilities()
              .then(function (caps) {
                if (!caps.recordsFolder) {
                  throw new Error(t('historyOpenFolderUnsupported'))
                }
                return api.openTransfersFolder()
              })
              .then(function (doc) {
                setHistoryBusy(false)
                if (doc && doc.ok === false) {
                  setListError((doc && doc.error) || t('actFailed', { detail: '' }))
                }
              })
              .catch(function (failure) {
                setHistoryBusy(false)
                setListError(messageOf(failure))
                logWarn('open transfers folder failed', failure)
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
           * 浮层挂到 document.body 上。
           * 插件根节点 `.mc-root` 是 overflow-y:auto 的滚动容器，直接在里面渲染 fixed 浮层
           * 会被祖先的层叠/裁剪上下文吃掉（同仓库的其他插件也踩过）。
           * 拿不到 react-dom 就退回内联。
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

          /**
           * 右侧文件区的投放蒙层（0.3.5）。
           *
           * 用户要求：把文件拖到「名称列那一条竖线右边、容量条下面」这一整块里就能上传。
           * 这块区域就是 `.mc-exMain`（列头 + 行 + 空白处都在里面），
           * 蒙层用 position:absolute 铺满它，pointer-events:none —— 只管看，不吃事件，
           * 事件由 `.mc-exMain` 自己接。
           */
          function renderListDropLayer() {
            if (!dragOver) return null
            return h('div', { className: 'mc-exDropLayer' },
              h('div', { className: 'mc-exDropCard' },
                h('div', { className: 'mc-exDropIcon' }, '⬆'),
                h('div', { className: 'mc-exDropTitle' }, t('listDropHere')),
                h('div', { className: 'mc-exDropPath', title: currentDirPath() }, currentDirPath()),
                h('div', { className: 'mc-exDropPath' }, t('listDropHint'))
              )
            )
          }

          /**
           * 拖拽上传的逐文件进度卡，钉在右侧文件区右上角。
           *
           * 以前这块在上传面板里，面板没了之后要有地方看「浏览器 → Host」这段的上行进度，
           * 所以挪到这里：绝对定位、不挡点击（pointer-events:none），传完自己消失。
           */
          function renderListUploadProgress() {
            if (!urlItems || urlItems.length === 0) return null
            return h('div', { className: 'mc-exDropProgress' },
              h('div', { className: 'mc-exDropProgressTitle' }, t('upload')),
              renderUrlLines()
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
              renderMovePicker(),
              renderRenameModal()
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
            // 浮层：菜单 / 转移 / 重命名 / 下载目录 / 历史记录
            renderMenu(),
            renderMovePicker(),
            renderRenameModal(),
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

          /**
           * 🔴 0.4.4 第 8 条：管住 DSH 那两条「拖动改变对话区宽度」的手柄。
           *
           * 现象：在移动云盘面板里，手指放在面板**左右边缘**附近一拖，
           * 变宽/变窄的却是外层对话区，而不是面板里的东西 —— 看起来像插件拖动失效。
           *
           * 根因（在 DSH 的 dsh-client-ui-conversation bundle 里确认）：
           * 对话列上铺了两条 `[data-width-handle=left|right]` 的绝对定位热区
           * （`.xxx_widthHandle`，`cursor:col-resize`，`top:0;bottom:0`），
           * 它们按「对话内容宽度」算位置，正好**压在插件面板的边缘上**。
           * 而且它那个宽度是写进 `--dsh-chat-user-width` 的全局偏好，
           * 拖一下就会影响所有对话页。
           *
           * 我们这一页不需要它：插件自己有左右分栏（左树 / 列表），
           * 面板宽度由 DSH 的侧栏决定。所以本页签挂载期间把这两条热区藏掉，
           * 切走时原样还原（记下原来的 display，不硬写值）。
           */
          function setWidthHandlesEnabled(enabled) {
            try {
              if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return
              var handles = document.querySelectorAll('[data-width-handle]')
              for (var i = 0; i < handles.length; i += 1) {
                var node = handles[i]
                if (!node || !node.style) continue
                if (!enabled) {
                  if (node.dataset.mcHandleOff !== '1') {
                    node.dataset.mcHandleOff = '1'
                    node.dataset.mcHandleBefore = node.style.display
                    node.style.display = 'none'
                  }
                } else if (node.dataset.mcHandleOff === '1') {
                  node.style.display = node.dataset.mcHandleBefore || ''
                  delete node.dataset.mcHandleOff
                  delete node.dataset.mcHandleBefore
                }
              }
            } catch (failure) {
              logWarn('width handle toggle failed', failure)
            }
          }

          function clearWidthHandles() {
            setWidthHandlesEnabled(true)
          }

          /**
           * View 的挂载点。
           *
           * 槽位只渲染当前选中的那个页签，所以「挂载」= 这个 tab 被选中：
           *   · 收起不需要的主输入框；
           *   · 关掉 DSH 的对话区宽度手柄（它们压在面板边缘上）；
           *   · 顺带把列宽手柄的全局样式也收一下（拖动时不影响外层）。
           * 卸载时全部还原。
           */
          function ViewMount() {
            React.useEffect(function () {
              setComposerHidden(true)
              setWidthHandlesEnabled(false)
              return function () {
                setComposerHidden(false)
                setWidthHandlesEnabled(true)
              }
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
              clearWidthHandles()
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
