function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function responseMessage(response) {
  return response?.json?.message || response?.statusText || '未知错误';
}

async function callApi(request, method, url, body, expectedStatus = 200) {
  const response = await request({
    method,
    url,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? null : JSON.stringify(body),
  });
  assertCondition(
    response?.status === expectedStatus,
    `${method} ${url} 预期 ${expectedStatus}，实际 ${response?.status || 0}: ${responseMessage(response)}`,
  );
  return response?.json?.data;
}

async function callAgentChat(request, projectId, sessionId) {
  const url = `/api/agent/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/chat`;
  const response = await request({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'Reply with the packaged smoke response.', approval: 'ask' }),
  });
  assertCondition(response?.status === 200, `Agent 首轮对话失败: ${response?.statusText || response?.status || 0}`);
  const stream = String(response?.body || '');
  assertCondition(stream.includes('packaged smoke agent reply'), 'Agent 首轮对话没有返回假模型内容');
  assertCondition(stream.includes('"type":"run.completed"'), 'Agent 首轮对话没有正常完成');
  return stream;
}

async function runPackagedSmoke({
  request,
  restartBackend,
  inspectRenderer,
  saveTextAttachment,
  inspectAttachment,
  modelBaseUrl,
}) {
  assertCondition(typeof request === 'function', '缺少打包 smoke 请求函数');
  assertCondition(typeof restartBackend === 'function', '缺少打包 smoke 后端重启函数');
  assertCondition(typeof inspectRenderer === 'function', '缺少打包 smoke Renderer 检查函数');
  assertCondition(typeof saveTextAttachment === 'function', '缺少打包 smoke 附件保存函数');
  assertCondition(typeof inspectAttachment === 'function', '缺少打包 smoke 附件检查函数');
  assertCondition(typeof modelBaseUrl === 'string' && modelBaseUrl, '缺少打包 smoke 假模型地址');

  const renderer = await inspectRenderer();
  assertCondition(renderer?.readyState === 'complete', 'Renderer 页面没有完成加载');
  assertCondition(renderer?.hasRoot === true, 'Renderer 根节点不存在');
  assertCondition(renderer?.hasElectronApi === true, 'preload 没有暴露 electronAPI');
  assertCondition(renderer?.bootScreenVisible === false, 'Renderer 仍停留在启动页');

  const project = await callApi(request, 'POST', '/api/projects', {
    name: 'Packaged smoke workspace',
    description: 'Temporary workspace created by packaged smoke',
  });
  assertCondition(project?.id, '创建工作区没有返回 id');

  const session = await callApi(request, 'POST', `/api/projects/${project.id}/sessions`, {
    title: 'Packaged smoke session',
  });
  assertCondition(session?.id, '创建会话没有返回 id');

  const attachmentText = 'persist attachment across packaged backend restart';
  const attachment = await saveTextAttachment({
    projectId: project.id,
    sessionId: session.id,
    content: attachmentText,
  });
  assertCondition(attachment?.path, '文本附件没有返回路径');
  assertCondition(attachment?.name?.endsWith('.txt'), '文本附件名称不正确');
  assertCondition(attachment?.size === Buffer.byteLength(attachmentText, 'utf8'), '文本附件大小不正确');

  const model = await callApi(request, 'POST', '/api/llm_model/create', {
    model_name: 'packaged-smoke-model',
    display_name: 'Packaged smoke model',
    category: 'PRIMARY',
    api_base: modelBaseUrl,
    api_key: '',
    api_format: 'chat_completions',
    is_enabled: true,
  });
  assertCondition(model?.id, '创建模型配置没有返回 id');
  assertCondition(model?.api_key === '', '空模型密钥不应写入凭据存储');

  const skillName = 'packaged-smoke-prompt';
  const skill = await callApi(request, 'POST', '/api/agent/skills', {
    name: skillName,
    description: 'Prompt Skill used by packaged smoke',
    instructions: 'Return a short smoke-test response.',
    runtime: 'prompt',
    allowed_tools: [],
    default_enabled: false,
    is_active: true,
  });
  assertCondition(skill?.name === skillName, '创建 Prompt Skill 返回内容不正确');
  assertCondition(skill?.runtime === 'prompt', 'Prompt Skill 运行类型不正确');

  const providerName = 'packaged-smoke-mcp';
  const provider = await callApi(request, 'POST', '/api/agent/mcp_providers', {
    provider_name: providerName,
    transport: 'stdio',
    command: 'pi-smoke-mcp',
    args: [],
    env: {},
    is_active: false,
    default_enabled: false,
  });
  assertCondition(provider?.provider_name === providerName, '创建 MCP 配置返回内容不正确');
  assertCondition(provider?.transport === 'stdio', 'MCP transport 不正确');

  await callApi(request, 'POST', `/api/projects/${project.id}/sessions/${session.id}/messages`, {
    role: 'user',
    content: 'persist across packaged backend restart',
  });

  await callAgentChat(request, project.id, session.id);

  const beforeRestartTraces = await callApi(
    request,
    'GET',
    `/api/agent/projects/${project.id}/sessions/${session.id}/traces`,
  );
  const firstTrace = beforeRestartTraces?.items?.[0]?.trace;
  assertCondition(firstTrace?.spanCount > 0, 'Agent 首轮对话没有写入 yiTrace');
  assertCondition(firstTrace?.spans?.some((span) => span.kind === 'llm'), 'yiTrace 没有记录 LLM 调用');

  const beforeRestart = await callApi(
    request,
    'GET',
    `/api/projects/${project.id}/sessions/${session.id}/messages`,
  );
  assertCondition(beforeRestart?.items?.length === 3, 'Agent 首轮对话没有完整写入会话消息');

  await restartBackend();

  const afterRestart = await callApi(
    request,
    'GET',
    `/api/projects/${project.id}/sessions/${session.id}/messages`,
  );
  const persistedText = afterRestart?.items?.[0]?.content_items?.[0]?.content;
  assertCondition(persistedText === 'persist across packaged backend restart', '后端重启后会话消息没有恢复');

  const afterRestartTraces = await callApi(
    request,
    'GET',
    `/api/agent/projects/${project.id}/sessions/${session.id}/traces`,
  );
  assertCondition(afterRestartTraces?.items?.[0]?.trace?.spanCount > 0, '后端重启后 yiTrace 数据没有恢复');

  const persistedAttachment = await inspectAttachment(attachment.path);
  assertCondition(persistedAttachment?.exists === true, '后端重启后文本附件不存在');
  assertCondition(persistedAttachment?.content === attachmentText, '后端重启后文本附件内容不正确');

  const persistedModel = await callApi(
    request,
    'GET',
    `/api/llm_model/detail?model_id=${encodeURIComponent(model.id)}`,
  );
  assertCondition(persistedModel?.model_name === 'packaged-smoke-model', '后端重启后模型配置没有恢复');

  const persistedSkill = await callApi(
    request,
    'GET',
    `/api/agent/skills/${encodeURIComponent(skillName)}`,
  );
  assertCondition(persistedSkill?.instructions === 'Return a short smoke-test response.', '后端重启后 Prompt Skill 没有恢复');

  const persistedProvider = await callApi(
    request,
    'GET',
    `/api/agent/mcp_providers/${encodeURIComponent(providerName)}`,
  );
  assertCondition(persistedProvider?.command === 'pi-smoke-mcp', '后端重启后 MCP 配置没有恢复');

  await callApi(request, 'POST', '/api/llm_model/delete', { model_id: model.id });
  await callApi(
    request,
    'GET',
    `/api/llm_model/detail?model_id=${encodeURIComponent(model.id)}`,
    undefined,
    404,
  );
  await callApi(request, 'DELETE', `/api/agent/skills/${encodeURIComponent(skillName)}`);
  await callApi(request, 'GET', `/api/agent/skills/${encodeURIComponent(skillName)}`, undefined, 404);
  await callApi(request, 'DELETE', `/api/agent/mcp_providers/${encodeURIComponent(providerName)}`);
  await callApi(request, 'GET', `/api/agent/mcp_providers/${encodeURIComponent(providerName)}`, undefined, 404);

  await callApi(request, 'DELETE', `/api/projects/${project.id}/sessions/${session.id}`);
  await callApi(request, 'GET', `/api/projects/${project.id}/sessions/${session.id}`, undefined, 404);
  await callApi(request, 'DELETE', `/api/projects/${project.id}`);

  return {
    projectId: project.id,
    sessionId: session.id,
    messageCount: afterRestart.items.length,
    attachmentName: attachment.name,
    traceSpanCount: afterRestartTraces.items[0].trace.spanCount,
  };
}

module.exports = { callApi, runPackagedSmoke };
