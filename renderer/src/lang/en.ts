export default {
  common: {
    add: 'Add',
    cancel: 'Cancel',
    cannotBeEmpty: 'cannot be empty',
    confirm: 'Confirm',
    confirmDelete: 'Are you sure you want to delete this?',
    confirmTitle: 'Confirm',
    copy: 'Copy',
    copyCode: 'Copy code',
    copyFailed: 'Copy failed',
    copySuccess: 'Copied',
    dataLoading: 'Loading data',
    delete: 'Delete',
    inputError: 'is invalid',
    loading: 'Loading',
    manage: 'Manage',
    notifyMsg: 'Enter a message',
    notifyTitle: 'Notice',
    save: 'Save',
    success: 'Done',
    tip: 'Notice',
    zoomView: 'Zoom',
    http: {
      requestFailed: 'Request failed',
      authFailed: 'Authentication failed',
      forbidden: 'Access denied',
      notFound: 'Resource not found',
      serverError: 'Request could not be processed',
      badRequest: 'Invalid request',
      clientError: 'Request error',
      internalError: 'Internal server error',
      networkError: 'Network connection failed'
    }
  },
  errorPage: {
    '401': { title: 'Access denied', desc: 'You do not have permission to view this page.' },
    '404': { title: 'Page not found', desc: 'The page does not exist. Check the link and try again.' },
    backHome: 'Back to home'
  },
  models: {
    title: 'Model Settings',
    description: 'Configure chat and embedding models used by the Agent',
    tabs: {
      chat: 'Primary Model',
      operatorChat: 'Secondary Model',
      embedding: 'Embedding Model'
    },
    role: {
      primaryDesc: 'Main chat model for tool use, multi-turn tasks, and core work',
      secondaryDesc: 'Companion model for lightweight analysis and content cleanup',
      embeddingDesc: 'Model used for semantic search and vector retrieval'
    },
    empty: {
      chatTitle: 'No primary model',
      chatDescReadonly: 'Configure a primary model in App settings first',
      operatorChatTitle: 'No secondary model',
      operatorChatDescReadonly: 'Configure a secondary model in App settings first',
      embeddingTitle: 'No embedding model',
      embeddingDescReadonly: 'Configure an embedding model in App settings first'
    },
    status: { unconfigured: 'Not configured' },
    form: {
      name: 'Model Name',
      apiBase: 'API Base URL',
      apiKey: 'API Key'
    },
    formCard: {
      basic: 'Basic Settings',
      batch: 'Batch Settings',
      extra: 'Extra Settings'
    },
    formLabel: {
      optional: 'Optional',
      extraHeaders: 'Extra Headers (JSON)',
      extraBody: 'Extra Body (JSON)',
      inputField: 'Input Field',
      supportsBatch: 'Batch Requests',
      batchSize: 'Batch Size',
      batchInputField: 'Batch Input Field',
      maxConcurrency: 'Max Concurrency',
      thinkingParam: 'Thinking Control Parameter',
      thinkingTitle: 'Model Thinking Settings'
    },
    thinkingSwitch: {
      on: 'Thinking disabled',
      off: 'Thinking enabled'
    },
    formTip: {
      supportsBatch: 'Send multiple texts in one request when supported',
      batchSize: 'Number of texts sent in each batch',
      batchInputField: 'Input field used by the batch endpoint, usually input',
      maxConcurrency: 'Maximum number of concurrent requests',
      inputField: 'Input field used by the endpoint, usually input',
      thinkingParam: 'Parameter used to control whether the model outputs its reasoning'
    },
    placeholder: {
      apiBase: 'For example, https://api.openai.com/v1',
      apiKey: 'Enter an API key (optional)',
      modelName: 'Enter a model name'
    },
    message: {
      deleteConfirm: 'Delete this model?',
      deleteSuccess: 'Model deleted',
      deleteError: 'Failed to delete model',
      updateSuccess: 'Model updated',
      createSuccess: 'Model created',
      fetchError: 'Failed to load {type} models',
      testConnectionSuccess: 'Connection test passed',
      testConnectionError: 'Connection test failed',
      testRequestError: 'Failed to send the test request',
      extraHeadersJsonError: 'Extra headers must be valid JSON',
      extraBodyJsonError: 'Extra body must be valid JSON',
      rawResponseCopied: 'Raw response copied'
    },
    rules: {
      modelName: 'Enter a model name',
      modelNameLength: 'Model name must be 2 to 100 characters',
      apiBase: 'Enter an API Base URL',
      dimension: 'Enter the vector dimension'
    },
    test: {
      testConfig: 'Test Connection',
      testing: 'Testing…',
      hint: 'Test the connection after filling in the settings',
      success: 'Test passed',
      failure: 'Test failed',
      responsePreview: 'Response Preview',
      chars: 'characters',
      vectorInfo: 'Vector Information',
      dimensions: 'dimensions',
      vectorPreview: 'Vector Preview',
      rawResponse: 'Raw Response',
      errorDetails: 'Error Details',
      formatErrorDetails: 'Format Error Details',
      fixSuggestions: 'Suggested Fixes',
      possibleSolutions: 'Try the following:',
      checkApiUrl: 'Check the API URL',
      checkRawResponse: 'Inspect the raw response returned by the service',
      confirmFormat: 'Confirm that the API response uses a supported format',
      chatFormatHint: 'Chat models must return standard text or message data',
      embeddingFormatHint: 'Embedding models must return an array of numbers',
      trySwitchCustom: 'Adjust the custom request parameters',
      adjustApiFormat: 'Update the API settings to match the raw response',
      typeConfigValidation: 'Configuration Check',
      typeConnectionTest: 'Connection Test',
      typeFormatError: 'Format Error',
      typeConnectionError: 'Connection Error',
      typeRequestError: 'Request Error',
      typeUnknown: 'Unknown Error'
    }
  },
  skills: {
    createSkill: 'New Skill',
    createFirst: 'Create Your First Skill',
    skillEmpty: {
      title: 'No Skills Yet',
      description: 'Skills are reusable capabilities that guide the Agent through a defined workflow.',
      feature1: 'Reuse prompts and workflows',
      feature2: 'Bind available tools',
      feature3: 'Enable per project'
    },
    edit: 'Edit',
    delete: 'Delete',
    tags: 'Tags',
    availableTools: 'Available Tools',
    instructions: 'Instructions',
    editSkill: 'Edit Skill',
    newSkill: 'New Skill',
    save: 'Save',
    create: 'Create',
    cancel: 'Cancel',
    toolsTitle: 'Available Tools',
    formName: 'Name',
    formNamePlaceholder: 'For example, code-review',
    formDesc: 'Description',
    formDescPlaceholder: 'Briefly describe what this Skill does',
    formCategory: 'Category',
    formCategoryPlaceholder: 'Select a category',
    categoryAnalysis: 'Analysis',
    categoryResearch: 'Research',
    categoryReport: 'Report',
    formTags: 'Tags',
    formTagsPlaceholder: 'Type a tag and press Enter',
    formTools: 'Available Tools',
    formInstructionsPlaceholder: 'Write detailed instructions in Markdown',
    sectionInstructions: 'Instructions',
    nameRequired: 'Enter a Skill name',
    descRequired: 'Enter a Skill description',
    fetchListFailed: 'Failed to load Skills',
    enabled: 'Enabled',
    disabled: 'Disabled',
    operationFailed: 'Operation failed',
    fetchDetailFailed: 'Failed to load Skill details',
    updateSuccess: 'Skill updated',
    createSuccess: 'Skill created',
    deleteConfirm: 'Delete Skill “{name}”? This cannot be undone.',
    deleteTitle: 'Delete Skill',
    confirmDelete: 'Delete',
    cancelDelete: 'Cancel',
    deleted: 'Skill “{name}” deleted',
    deleteFailed: 'Failed to delete Skill',
    fetchToolsFailed: 'Failed to load tools'
  },
  mcpProvider: {
    title: 'MCP Provider',
    detail: {
      enabled: 'Enabled',
      disabled: 'Disabled',
      tabs: { info: 'Basic Info', settings: 'Settings' },
      sections: { launch: 'Launch Settings', env: 'Environment Variables' },
      noEnv: 'No environment variables',
      lastErrorTitle: 'Last tool discovery failed',
      createdAt: 'Created',
      updatedAt: 'Updated',
      testConnection: 'Test Connection',
      testing: 'Testing…',
      testResult: {
        successTitle: 'Connection Successful',
        successSummary: 'Discovered {count} tools',
        failTitle: 'Connection Failed',
        close: 'Close'
      },
      save: 'Save'
    },
    list: {
      statusDisabled: 'Disabled',
      empty: {
        title: 'No MCP Providers Yet',
        description: 'Connect an external MCP Server to make its tools available to the Agent.',
        cta: 'New Provider',
        featureStdio: 'stdio subprocesses',
        featureAutoDiscover: 'Automatic tool discovery',
        featurePerProject: 'Per-project settings'
      },
      card: {
        argsCount: '{n} arguments',
        envCount: '{n} environment variables',
        hasError: 'Last discovery failed',
        lastDiscovered: 'Last discovered: {time}'
      },
      columns: { lastDiscovered: 'Last Discovered' },
      actions: { delete: 'Delete' },
      deleteConfirm: {
        title: 'Delete Provider',
        message: 'Delete this Provider? Its tools will no longer be available.',
        ok: 'Delete',
        cancel: 'Cancel'
      }
    },
    form: {
      providerName: 'Provider Name',
      transport: 'Transport',
      command: 'Launch Command',
      commandPlaceholder: 'For example, npx, uvx, or an absolute executable path',
      args: 'Arguments',
      env: 'Environment Variables',
      envKeyPlaceholder: 'Variable name',
      envValuePlaceholder: 'Value',
      show: 'Show',
      hide: 'Hide',
      cancel: 'Cancel'
    },
    messages: {
      createSuccess: 'Provider created',
      updateSuccess: 'Provider saved',
      deleteSuccess: 'Provider deleted',
      testFail: 'Connection test failed'
    },
    wizard: {
      step1: {
        railLabel: 'Basic Info',
        title: 'Enter a name and launch method',
        desc: 'Name the Provider and enter the command used to launch its MCP Server.',
        namePlaceholder: 'For example, github',
        nameHint: 'Use lowercase letters, digits, hyphens, or underscores.',
        commandPlaceholder: 'For example, npx, uvx, or an absolute executable path',
        commandHint: 'Node projects usually use npx, Python projects often use uvx, or you can enter a binary path.',
        argFlagLabel: 'Argument',
        argValueLabel: 'Value',
        argFlagPlaceholder: 'For example, --transport',
        argValuePlaceholder: 'For example, stdio',
        argsAddRow: 'Add Row',
        argsHint: 'Enter one argument per row. Arguments are passed in the displayed order.',
        secretArgNote: 'Sensitive data detected. It is hidden in the preview but stored as plain text.',
        transportHint: 'stdio local subprocesses are currently supported.',
        previewLabel: 'Launch Command Preview'
      },
      step2: {
        railLabel: 'Environment',
        title: 'Enter environment variables',
        desc: 'Add tokens, API keys, or other variables required by the MCP Server.',
        key: 'Variable',
        value: 'Value',
        emptyLine1: 'Continue if this Provider does not need environment variables.',
        emptyLine2: 'Common variable names include API_TOKEN and API_KEY.',
        addRow: 'Add Row'
      },
      step3: {
        railLabel: 'Test and Save',
        title: 'Check available tools',
        desc: 'Launch the MCP Server once and inspect the tools it provides before saving.',
        launch: 'Launch Command',
        ctaHeadline: 'Configuration is ready',
        ctaSub: 'Run a real connection test with the settings above.',
        runTest: 'Test Connection',
        running: 'Connecting',
        runningSub: 'Launching the subprocess and requesting its tool list…',
        successHeadline: 'Connection successful',
        successSub: 'Discovered {count} tools',
        failHeadline: 'Connection failed',
        failSub: 'Check the command, arguments, and environment variables.',
        retest: 'Test Again',
        retry: 'Retry',
        toolName: 'Tool',
        toolDesc: 'Description'
      },
      footer: {
        back: 'Back',
        next: 'Next',
        save: 'Save Provider',
        saveAnyway: 'Save Anyway'
      }
    }
  }
}
