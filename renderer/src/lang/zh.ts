export default {
  common: {
    add: '添加',
    cancel: '取消',
    cannotBeEmpty: '不能为空',
    confirm: '确认',
    confirmDelete: '确定要删除吗？',
    confirmTitle: '确认',
    copy: '复制',
    copyCode: '复制代码',
    copyFailed: '复制失败',
    copySuccess: '复制成功',
    dataLoading: '正在加载数据',
    delete: '删除',
    inputError: '输入有误',
    loading: '加载中',
    manage: '管理',
    notifyMsg: '请填写提示内容',
    notifyTitle: '提示',
    save: '保存',
    success: '操作成功',
    tip: '提示',
    zoomView: '放大查看',
    http: {
      requestFailed: '请求失败',
      authFailed: '身份验证失败',
      forbidden: '无权访问',
      notFound: '资源不存在',
      serverError: '请求无法处理',
      badRequest: '请求参数错误',
      clientError: '请求错误',
      internalError: '服务内部错误',
      networkError: '网络连接失败'
    }
  },
  errorPage: {
    '401': { title: '无权访问', desc: '你没有访问该页面的权限。' },
    '404': { title: '页面不存在', desc: '你访问的页面不存在，请检查链接。' },
    backHome: '返回首页'
  },
  models: {
    title: '模型管理',
    description: '配置 Agent 使用的对话模型和向量模型',
    tabs: {
      chat: '主模型',
      operatorChat: '副模型',
      embedding: '向量模型'
    },
    role: {
      primaryDesc: '主力对话模型，负责工具调用、多轮任务等核心工作',
      secondaryDesc: '用于轻量分析和内容整理等小型任务',
      embeddingDesc: '用于语义搜索和向量检索'
    },
    empty: {
      chatTitle: '暂无主模型',
      chatDescReadonly: '请先在 App 设置中配置主模型',
      operatorChatTitle: '暂无副模型',
      operatorChatDescReadonly: '请先在 App 设置中配置副模型',
      embeddingTitle: '暂无向量模型',
      embeddingDescReadonly: '请先在 App 设置中配置向量模型'
    },
    status: { unconfigured: '未配置' },
    form: {
      name: '模型名称',
      apiBase: 'API 地址',
      apiKey: 'API 密钥'
    },
    formCard: {
      basic: '基本配置',
      batch: '批处理配置',
      extra: '额外配置'
    },
    formLabel: {
      optional: '可选',
      extraHeaders: '额外请求头（JSON）',
      extraBody: '额外请求体（JSON）',
      inputField: '输入字段名',
      supportsBatch: '支持批处理',
      batchSize: '每批数量',
      batchInputField: '批处理输入字段名',
      maxConcurrency: '最大并发数',
      thinkingParam: '思考控制参数',
      thinkingTitle: '模型思考设置'
    },
    thinkingSwitch: {
      on: '已关闭思考',
      off: '保留思考'
    },
    formTip: {
      supportsBatch: '启用后，可在一次请求中提交多个文本',
      batchSize: '每批发送的文本数量',
      batchInputField: '批量接口的输入字段名，通常为 input',
      maxConcurrency: '同时发出的最大请求数',
      inputField: '单条接口的输入字段名，通常为 input',
      thinkingParam: '控制模型是否输出思考内容的参数名'
    },
    placeholder: {
      apiBase: '例如 https://api.openai.com/v1',
      apiKey: '请输入 API 密钥（可选）',
      modelName: '请输入模型名称'
    },
    message: {
      deleteConfirm: '确定要删除这个模型吗？',
      deleteSuccess: '模型已删除',
      deleteError: '删除模型失败',
      updateSuccess: '模型已更新',
      createSuccess: '模型已创建',
      fetchError: '获取{type}模型失败',
      testConnectionSuccess: '连接测试成功',
      testConnectionError: '连接测试失败',
      testRequestError: '发送测试请求失败',
      extraHeadersJsonError: '额外请求头不是有效的 JSON',
      extraBodyJsonError: '额外请求体不是有效的 JSON',
      rawResponseCopied: '原始响应已复制'
    },
    rules: {
      modelName: '请输入模型名称',
      modelNameLength: '模型名称应为 2 到 100 个字符',
      apiBase: '请输入 API 地址',
      dimension: '请输入向量维度'
    },
    test: {
      testConfig: '测试连接',
      testing: '测试中…',
      hint: '填写配置后，可以先检查连接是否正常',
      success: '测试成功',
      failure: '测试失败',
      responsePreview: '响应预览',
      chars: '字符',
      vectorInfo: '向量信息',
      dimensions: '维',
      vectorPreview: '向量预览',
      rawResponse: '原始响应',
      errorDetails: '错误详情',
      formatErrorDetails: '格式错误详情',
      fixSuggestions: '修复建议',
      possibleSolutions: '可以尝试：',
      checkApiUrl: '检查 API 地址是否正确',
      checkRawResponse: '查看原始响应，确认服务实际返回的内容',
      confirmFormat: '确认 API 返回格式符合要求',
      chatFormatHint: '对话模型需要返回标准文本或消息结构',
      embeddingFormatHint: '向量模型需要返回数值数组',
      trySwitchCustom: '尝试调整自定义请求参数',
      adjustApiFormat: '根据原始响应调整接口配置',
      typeConfigValidation: '配置检查',
      typeConnectionTest: '连接测试',
      typeFormatError: '格式错误',
      typeConnectionError: '连接错误',
      typeRequestError: '请求错误',
      typeUnknown: '未知错误'
    }
  },
  skills: {
    createSkill: '新建 Skill',
    createFirst: '创建第一个 Skill',
    skillEmpty: {
      title: '还没有 Skill',
      description: 'Skill 是可复用的能力模块，让 Agent 按预设流程完成任务。',
      feature1: '复用提示词和工作流程',
      feature2: '绑定可用工具',
      feature3: '按项目启用或停用'
    },
    edit: '编辑',
    delete: '删除',
    tags: '标签',
    availableTools: '可用工具',
    instructions: '详细说明',
    editSkill: '编辑 Skill',
    newSkill: '新建 Skill',
    save: '保存',
    create: '创建',
    cancel: '取消',
    toolsTitle: '可用工具',
    formName: '名称',
    formNamePlaceholder: '例如 code-review',
    formDesc: '描述',
    formDescPlaceholder: '简要说明这个 Skill 能做什么',
    formCategory: '分类',
    formCategoryPlaceholder: '请选择分类',
    categoryAnalysis: '分析',
    categoryResearch: '调研',
    categoryReport: '报告',
    formTags: '标签',
    formTagsPlaceholder: '输入标签后按回车',
    formTools: '可用工具',
    formInstructionsPlaceholder: '填写详细指令，支持 Markdown',
    sectionInstructions: '指令',
    nameRequired: '请输入 Skill 名称',
    descRequired: '请输入 Skill 描述',
    fetchListFailed: '获取 Skill 列表失败',
    enabled: '已启用',
    disabled: '已停用',
    operationFailed: '操作失败',
    fetchDetailFailed: '获取 Skill 详情失败',
    updateSuccess: 'Skill 已更新',
    createSuccess: 'Skill 已创建',
    deleteConfirm: '确定要删除 Skill“{name}”吗？此操作无法恢复。',
    deleteTitle: '删除 Skill',
    confirmDelete: '删除',
    cancelDelete: '取消',
    deleted: 'Skill“{name}”已删除',
    deleteFailed: '删除 Skill 失败',
    fetchToolsFailed: '获取工具列表失败'
  },
  mcpProvider: {
    title: 'MCP Provider',
    detail: {
      enabled: '已启用',
      disabled: '已停用',
      tabs: { info: '基本信息', settings: '设置' },
      sections: { launch: '启动配置', env: '环境变量' },
      noEnv: '未配置环境变量',
      lastErrorTitle: '最近一次发现工具失败',
      createdAt: '创建时间',
      updatedAt: '更新时间',
      testConnection: '测试连接',
      testing: '测试中…',
      testResult: {
        successTitle: '连接成功',
        successSummary: '发现 {count} 个工具',
        failTitle: '连接失败',
        close: '关闭'
      },
      save: '保存'
    },
    list: {
      statusDisabled: '已停用',
      empty: {
        title: '还没有 MCP Provider',
        description: '接入外部 MCP Server 后，它提供的工具会自动注册给 Agent。',
        cta: '新建 Provider',
        featureStdio: '支持 stdio 子进程',
        featureAutoDiscover: '自动发现工具',
        featurePerProject: '可按项目单独配置'
      },
      card: {
        argsCount: '{n} 个参数',
        envCount: '{n} 个环境变量',
        hasError: '上次发现失败',
        lastDiscovered: '最近发现：{time}'
      },
      columns: { lastDiscovered: '最近发现' },
      actions: { delete: '删除' },
      deleteConfirm: {
        title: '删除 Provider',
        message: '确定要删除这个 Provider 吗？相关工具将无法继续使用。',
        ok: '删除',
        cancel: '取消'
      }
    },
    form: {
      providerName: 'Provider 名称',
      transport: '传输方式',
      command: '启动命令',
      commandPlaceholder: '例如 npx、uvx 或可执行文件绝对路径',
      args: '参数',
      env: '环境变量',
      envKeyPlaceholder: '变量名',
      envValuePlaceholder: '变量值',
      show: '显示',
      hide: '隐藏',
      cancel: '取消'
    },
    messages: {
      createSuccess: 'Provider 已创建',
      updateSuccess: 'Provider 已保存',
      deleteSuccess: 'Provider 已删除',
      testFail: '连接测试失败'
    },
    wizard: {
      step1: {
        railLabel: '基本信息',
        title: '填写名称和启动方式',
        desc: '为 Provider 设置名称，并填写启动 MCP Server 所需的命令。',
        namePlaceholder: '例如 github',
        nameHint: '只能使用小写字母、数字、连字符或下划线。',
        commandPlaceholder: '例如 npx、uvx 或可执行文件绝对路径',
        commandHint: 'Node 项目通常使用 npx，Python 项目通常使用 uvx，也可以填写二进制文件路径。',
        argFlagLabel: '参数名',
        argValueLabel: '参数值',
        argFlagPlaceholder: '例如 --transport',
        argValuePlaceholder: '例如 stdio',
        argsAddRow: '添加一行',
        argsHint: '每行填写一个参数，提交时会按当前顺序依次展开。',
        secretArgNote: '检测到敏感参数，预览中已隐藏，保存时仍为明文。',
        transportHint: '当前支持 stdio，也就是本地子进程。',
        previewLabel: '启动命令预览'
      },
      step2: {
        railLabel: '环境变量',
        title: '填写环境变量',
        desc: '如果 MCP Server 需要 Token、API Key 或其他密钥，请在这里填写。',
        key: '变量名',
        value: '变量值',
        emptyLine1: '如果不需要环境变量，可以直接继续。',
        emptyLine2: '常见环境变量包括 API_TOKEN、API_KEY 等。',
        addRow: '添加一行'
      },
      step3: {
        railLabel: '测试并保存',
        title: '检查可用工具',
        desc: '保存前启动一次 MCP Server，检查它能提供哪些工具。',
        launch: '启动命令',
        ctaHeadline: '配置已填写完成',
        ctaSub: '点击下面的按钮，执行一次真实连接测试。',
        runTest: '测试连接',
        running: '正在连接',
        runningSub: '正在启动子进程并获取工具列表…',
        successHeadline: '连接正常',
        successSub: '发现 {count} 个工具',
        failHeadline: '连接失败',
        failSub: '请检查命令、参数和环境变量。',
        retest: '重新测试',
        retry: '重试',
        toolName: '工具名',
        toolDesc: '描述'
      },
      footer: {
        back: '上一步',
        next: '下一步',
        save: '保存 Provider',
        saveAnyway: '仍然保存'
      }
    }
  }
}
