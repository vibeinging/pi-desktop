// 项目能力探测(从 SuperAgent.probe_capabilities 提取,去 BaseAgent 依赖)。
// 数据源能力只从 BusinessDataSources 读取。

/**
 * 业务能力快照——决定 QueryAgent 在 buildQueryTools 中暴露哪些工具。
 *
 * 探测来源：
 * - has_structured / has_unstructured / has_web_search：BusinessDataSources
 *   内存对象 O(1) 读取（task_service 已加载，无 db round-trip）
 * 注册门控 = prompt 门控（buildQueryTools 只输出真实注册的工具），单一变更点。
 *
 * （原 superagent_models.js 已随 SuperAgent 框架删除；本类是唯一存活者，内联到此。）
 */
export class BusinessCapabilities {
  /**
   * @param {object} [opts]
   * @param {boolean} [opts.has_structured=false]
   * @param {boolean} [opts.has_unstructured=false]
   * @param {boolean} [opts.has_web_search=false]
   * @param {boolean} [opts.has_any=false]
   */
  constructor({
    has_structured = false,
    has_unstructured = false,
    has_web_search = false,
    has_any = false,
  } = {}) {
    this.has_structured = has_structured;
    this.has_unstructured = has_unstructured;
    this.has_web_search = has_web_search;
    this.has_any = has_any;

    // 模拟 frozen=True：防止意外写入（开发期友好提示）
    if (process.env.NODE_ENV !== 'production') {
      Object.freeze(this);
    }
  }

  /** 对应 Python classmethod empty() */
  static empty() {
    return new BusinessCapabilities();
  }
}

/**
 * @param {import('../datasources/business_data_sources.js').BusinessDataSources|null} bds
 * @param {string|null} project_id
 * @param {object|null} [ctx=null]
 * @returns {Promise<BusinessCapabilities>}
 */
export async function probeCapabilities(bds, _project_id, _ctx = null) {
  let has_structured = false;
  let has_unstructured = false;
  let has_web_search = false;
  let has_mcp = false;
  if (bds != null) {
    has_structured = Boolean(
      (bds.get_database_sources()?.length || 0) ||
        (bds.get_temp_file_sources()?.length || 0),
    );
    has_unstructured = Boolean(bds.get_unstructured_sources()?.length || 0);
    has_web_search = Boolean(bds.web_search_configs && bds.web_search_configs.size > 0);
    has_mcp = Boolean(bds.get_mcp_sources()?.length || 0);
  }

  const has_any = has_structured || has_unstructured || has_web_search || has_mcp;
  return new BusinessCapabilities({
    has_structured, has_unstructured, has_web_search, has_any,
  });
}
