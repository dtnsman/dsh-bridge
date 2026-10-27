// src/catalog.js
// DSH 端点目录（静态）。
// 数据来源：DSH-HTTP-API.md §5，从 app.asar 的 typert.host.js 提取。
// 用途：GET /api/endpoints 返回给远程 Agent，使其具备自描述能力。

const ENDPOINTS = [
  // ===== account =====
  { ns: 'account', method: 'ackBonusNotified',    mode: 'unary', args: ['accountId','orderId','client'] },
  { ns: 'account', method: 'cancelSignIn',        mode: 'unary', args: ['attemptId'] },
  { ns: 'account', method: 'getBalance',          mode: 'unary', args: ['client'] },
  { ns: 'account', method: 'getProfile',          mode: 'unary', args: ['client'] },
  { ns: 'account', method: 'getState',            mode: 'unary', args: [] },
  { ns: 'account', method: 'getUnnotifiedBonuses',mode: 'unary', args: ['client'] },
  { ns: 'account', method: 'hasRunningAccountTasks', mode: 'unary', args: [] },
  { ns: 'account', method: 'signOut',             mode: 'unary', args: ['client'] },
  { ns: 'account', method: 'startSignIn',         mode: 'unary', args: ['client','callbackOrigin','loginSource'] },
  { ns: 'account', method: 'watch',               mode: 'stream', args: [] },
  { ns: 'account', method: 'watchExpiry',         mode: 'stream', args: [] },

  // ===== agentPresets =====
  { ns: 'agentPresets', method: 'list',   mode: 'unary',  args: [] },
  { ns: 'agentPresets', method: 'read',   mode: 'unary',  args: ['agentPreset'] },
  { ns: 'agentPresets', method: 'select', mode: 'unary',  args: ['agentPreset'] },

  // ===== commands =====
  { ns: 'commands', method: 'execute', mode: 'unary', args: ['line','submittedAttachments'] },
  { ns: 'commands', method: 'list',    mode: 'unary', args: [] },

  // ===== credentials =====
  { ns: 'credentials', method: 'describe', mode: 'unary', args: ['refs'] },
  { ns: 'credentials', method: 'set',      mode: 'unary', args: ['ref','value'] },
  { ns: 'credentials', method: 'unset',    mode: 'unary', args: ['ref'] },

  // ===== directoryPicker =====
  { ns: 'directoryPicker', method: 'createDirectory', mode: 'unary', args: ['path','name'] },
  { ns: 'directoryPicker', method: 'list',            mode: 'unary', args: ['path'] },
  { ns: 'directoryPicker', method: 'pick',            mode: 'unary', args: [] },

  // ===== dynamicCordisRunner =====
  { ns: 'dynamicCordisRunner', method: 'getClientCode',              mode: 'unary', args: ['pluginId','pluginRunId'] },
  { ns: 'dynamicCordisRunner', method: 'inventory',                  mode: 'unary', args: [] },
  { ns: 'dynamicCordisRunner', method: 'invoke',                     mode: 'unary', args: ['pluginId','pluginRunId','method','args'] },
  { ns: 'dynamicCordisRunner', method: 'reportClientGuardFailure',   mode: 'unary', args: ['pluginId','pluginRunId','failure'] },
  { ns: 'dynamicCordisRunner', method: 'reportRenderFailure',        mode: 'unary', args: ['pluginId','pluginRunId','failure'] },
  { ns: 'dynamicCordisRunner', method: 'resolveInspectQuery',        mode: 'unary', args: ['requestId','resolution'] },
  { ns: 'dynamicCordisRunner', method: 'resolveRequestRun',          mode: 'unary', args: ['requestId','resolution'] },
  { ns: 'dynamicCordisRunner', method: 'runHostHalf',                mode: 'unary', args: ['pluginId','packageId','mode','requestId','approveFutureVersions'] },
  { ns: 'dynamicCordisRunner', method: 'settleUserRun',              mode: 'unary', args: ['pluginId','resolution'] },
  { ns: 'dynamicCordisRunner', method: 'stopFromPanel',              mode: 'unary', args: ['pluginId'] },
  { ns: 'dynamicCordisRunner', method: 'syncInspectManifest',        mode: 'unary', args: ['providers'] },
  { ns: 'dynamicCordisRunner', method: 'undefineFromPanel',          mode: 'unary', args: ['pluginId'] },

  // ===== fileReferences =====
  { ns: 'fileReferences', method: 'list', mode: 'unary', args: ['query'] },

  // ===== fileUploads =====
  { ns: 'fileUploads', method: 'upload', mode: 'unary', args: ['request'] },

  // ===== goals =====
  { ns: 'goals', method: 'clear',    mode: 'unary', args: ['ref'] },
  { ns: 'goals', method: 'complete', mode: 'unary', args: ['ref'] },
  { ns: 'goals', method: 'create',   mode: 'unary', args: ['request'] },
  { ns: 'goals', method: 'edit',     mode: 'unary', args: ['ref','request'] },
  { ns: 'goals', method: 'get',      mode: 'unary', args: [] },
  { ns: 'goals', method: 'pause',    mode: 'unary', args: ['ref'] },
  { ns: 'goals', method: 'resume',   mode: 'unary', args: ['ref'] },

  // ===== job =====
  { ns: 'job', method: 'follow', mode: 'stream', args: ['request'] },
  { ns: 'job', method: 'kill',   mode: 'unary',  args: ['request'] },
  { ns: 'job', method: 'list',   mode: 'stream', args: ['request'] },

  // ===== llm =====
  { ns: 'llm', method: 'discoverModels',             mode: 'unary', args: ['settingsNs','request'] },
  { ns: 'llm', method: 'listConfigurableProviders',  mode: 'unary', args: [] },
  { ns: 'llm', method: 'listProviders',              mode: 'unary', args: [] },

  // ===== messageFeedback =====
  { ns: 'messageFeedback', method: 'delete', mode: 'unary', args: ['request'] },
  { ns: 'messageFeedback', method: 'list',   mode: 'unary', args: ['request'] },
  { ns: 'messageFeedback', method: 'put',    mode: 'unary', args: ['request'] },

  // ===== officeToPdf =====
  { ns: 'officeToPdf', method: 'generation', mode: 'unary', args: [] },
  { ns: 'officeToPdf', method: 'render',     mode: 'unary', args: ['path','priority'] },

  // ===== permissionPresets =====
  { ns: 'permissionPresets', method: 'catalog', mode: 'unary', args: [] },

  // ===== pluginInventory =====
  { ns: 'pluginInventory', method: 'list', mode: 'unary', args: [] },

  // ===== pluginManager =====
  { ns: 'pluginManager', method: 'cancelInstall',        mode: 'unary', args: ['requestId'] },
  { ns: 'pluginManager', method: 'inspect',              mode: 'unary', args: ['spec','options'] },
  { ns: 'pluginManager', method: 'installBundle',        mode: 'unary', args: ['spec','options'] },
  { ns: 'pluginManager', method: 'listBundles',          mode: 'unary', args: [] },
  { ns: 'pluginManager', method: 'listPlugins',          mode: 'unary', args: [] },
  { ns: 'pluginManager', method: 'listVersionExemptions',mode: 'unary', args: [] },
  { ns: 'pluginManager', method: 'registries',           mode: 'unary', args: [] },
  { ns: 'pluginManager', method: 'removeBundle',         mode: 'unary', args: ['name'] },
  { ns: 'pluginManager', method: 'setBundleEnabled',     mode: 'unary', args: ['name','enabled'] },
  { ns: 'pluginManager', method: 'setPluginEnabled',     mode: 'unary', args: ['id','enabled'] },
  { ns: 'pluginManager', method: 'setVersionExemption',  mode: 'unary', args: ['packageVersion','runtimeVersion','enabled','acceptRisk'] },
  { ns: 'pluginManager', method: 'waitForInstall',       mode: 'unary', args: ['requestId'] },

  // ===== pluginRegistryProbe =====
  { ns: 'pluginRegistryProbe', method: 'fastest', mode: 'unary', args: [] },

  // ===== productAnalytics =====
  { ns: 'productAnalytics', method: 'enabled',     mode: 'unary',  args: [] },
  { ns: 'productAnalytics', method: 'report',      mode: 'unary',  args: ['event'] },
  { ns: 'productAnalytics', method: 'watchPolicy', mode: 'stream', args: [] },

  // ===== session =====
  { ns: 'session', method: 'attachment',              mode: 'unary',  args: ['request'] },
  { ns: 'session', method: 'cancel',                  mode: 'unary',  args: ['request'] },
  { ns: 'session', method: 'canOpenWorkspacePath',    mode: 'unary',  args: [] },
  { ns: 'session', method: 'control',                 mode: 'stream', args: [] },
  { ns: 'session', method: 'create',                  mode: 'unary',  args: ['request'] },
  { ns: 'session', method: 'follow',                  mode: 'stream', args: ['request'] },
  { ns: 'session', method: 'fork',                    mode: 'unary',  args: ['request'] },
  { ns: 'session', method: 'initializeDefaultModel',  mode: 'unary',  args: [] },
  // ★ 注意：session/list 的 wire 字段是 _request
  { ns: 'session', method: 'list',                    mode: 'unary',  args: ['_request'] },
  { ns: 'session', method: 'modelCatalog',            mode: 'unary',  args: [] },
  { ns: 'session', method: 'openWorkspacePath',       mode: 'unary',  args: ['request'] },
  { ns: 'session', method: 'page',                    mode: 'unary',  args: ['request'] },
  { ns: 'session', method: 'projections',             mode: 'unary',  args: ['request'] },
  { ns: 'session', method: 'prompt',                  mode: 'unary',  args: ['request'] },
  { ns: 'session', method: 'rename',                  mode: 'unary',  args: ['request'] },
  { ns: 'session', method: 'search',                  mode: 'unary',  args: ['request'] },
  { ns: 'session', method: 'selectModel',             mode: 'unary',  args: ['request'] },
  { ns: 'session', method: 'updateQueue',             mode: 'unary',  args: ['request'] },
  { ns: 'session', method: 'workspacePathApplications', mode: 'unary', args: ['request'] },

  // ===== sessionFeedback =====
  { ns: 'sessionFeedback', method: 'record', mode: 'unary', args: ['request'] },

  // ===== sessionReferenceResolver =====
  { ns: 'sessionReferenceResolver', method: 'candidates', mode: 'unary', args: ['query'] },

  // ===== settings =====
  { ns: 'settings', method: 'describe',              mode: 'unary', args: [] },
  { ns: 'settings', method: 'mutate',                mode: 'unary', args: ['ns','ops','expectedRevision'] },
  { ns: 'settings', method: 'openSettingsDocument',  mode: 'unary', args: [] },
  { ns: 'settings', method: 'replace',               mode: 'unary', args: ['ns','section','expectedRevision'] },
  { ns: 'settings', method: 'update',                mode: 'unary', args: ['ns','patch','expectedRevision'] },

  // ===== skills =====
  { ns: 'skills', method: 'list', mode: 'unary', args: ['request'] },

  // ===== subagents =====
  { ns: 'subagents', method: 'interruptByParent', mode: 'unary', args: ['childSessionId','parentSessionId','mode'] },
  { ns: 'subagents', method: 'prompt',            mode: 'unary', args: ['request'] },

  // ===== terminal =====
  { ns: 'terminal', method: 'close',       mode: 'unary',  args: ['id'] },
  { ns: 'terminal', method: 'create',      mode: 'unary',  args: ['request'] },
  { ns: 'terminal', method: 'environment', mode: 'unary',  args: [] },
  { ns: 'terminal', method: 'follow',      mode: 'stream', args: ['id','attachmentId'] },
  { ns: 'terminal', method: 'list',        mode: 'unary',  args: ['sessionId'] },
  { ns: 'terminal', method: 'rename',      mode: 'unary',  args: ['id','title'] },
  { ns: 'terminal', method: 'resize',      mode: 'unary',  args: ['id','attachmentId','cols','rows'] },
  { ns: 'terminal', method: 'retain',      mode: 'stream', args: ['sessionId','id'] },
  { ns: 'terminal', method: 'shells',      mode: 'unary',  args: [] },
  { ns: 'terminal', method: 'write',       mode: 'unary',  args: ['id','attachmentId','data'] },

  // ===== userQuestions =====
  { ns: 'userQuestions', method: 'answer',     mode: 'unary',  args: ['callId','answer'] },
  { ns: 'userQuestions', method: 'attachWait', mode: 'stream', args: ['callId'] },

  // ===== workspace =====
  { ns: 'workspace', method: 'archiveSession',       mode: 'unary',  args: ['request'] },
  { ns: 'workspace', method: 'create',               mode: 'unary',  args: ['request'] },
  { ns: 'workspace', method: 'delete',               mode: 'unary',  args: ['request'] },
  { ns: 'workspace', method: 'follow',               mode: 'stream', args: [] },
  { ns: 'workspace', method: 'initializeDefault',    mode: 'unary',  args: [] },
  { ns: 'workspace', method: 'insertBefore',         mode: 'unary',  args: ['request'] },
  { ns: 'workspace', method: 'insertSessionBefore',  mode: 'unary',  args: ['request'] },
  { ns: 'workspace', method: 'pinSession',           mode: 'unary',  args: ['request'] },
  { ns: 'workspace', method: 'rename',               mode: 'unary',  args: ['request'] },
  { ns: 'workspace', method: 'unarchiveSession',     mode: 'unary',  args: ['request'] },
  { ns: 'workspace', method: 'unpinSession',         mode: 'unary',  args: ['request'] },

  // ===== workspaceFiles =====
  { ns: 'workspaceFiles', method: 'changes',   mode: 'stream', args: ['path'] },
  { ns: 'workspaceFiles', method: 'list',      mode: 'unary',  args: ['path'] },
  { ns: 'workspaceFiles', method: 'read',      mode: 'unary',  args: ['path','range'] },
  { ns: 'workspaceFiles', method: 'readBytes', mode: 'unary',  args: ['path','options'] },
  { ns: 'workspaceFiles', method: 'stat',      mode: 'unary',  args: ['path'] },

  // ===== 第三方插件（示例） =====
  { ns: 'whalePet', method: 'watch', mode: 'stream', args: [], thirdParty: true },
];

// 未挂载的命名空间（profile 不组合，调用会 404）
const UNMOUNTED_NAMESPACES = ['schedule', 'speech'];

function buildCatalog() {
  const byNs = {};
  for (const e of ENDPOINTS) {
    (byNs[e.ns] ||= []).push(e);
  }
  return {
    total: ENDPOINTS.length,
    unmounted: UNMOUNTED_NAMESPACES,
    namespaces: Object.keys(byNs).sort(),
    endpoints: ENDPOINTS,
    byNamespace: byNs,
    generatedAt: new Date().toISOString(),
    source: 'DSH-HTTP-API.md §5',
  };
}

module.exports = { ENDPOINTS, UNMOUNTED_NAMESPACES, buildCatalog };