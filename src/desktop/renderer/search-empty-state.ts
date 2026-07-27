export type SearchEmptyScope = "smart" | "current";

export interface SearchEmptyStatus {
  state: "success" | "error";
}

export interface SearchEmptyStateInput {
  keyword: string;
  scope: SearchEmptyScope;
  expandedToAllSources: boolean;
  statuses: SearchEmptyStatus[];
}

export interface SearchEmptyStateCopy {
  title: string;
  description: string;
}

export function resolveSearchEmptyState(input: SearchEmptyStateInput): SearchEmptyStateCopy {
  const keyword = input.keyword.trim();
  if (!keyword) {
    return {
      title: "搜索你想看的内容",
      description: "输入片名、演员或导演，系统会优先从当前、最近使用和高质量来源查找。",
    };
  }

  const successCount = input.statuses.filter((status) => status.state === "success").length;
  const errorCount = input.statuses.filter((status) => status.state === "error").length;

  if (input.scope === "current") {
    if (errorCount > 0 && successCount === 0) {
      return {
        title: "当前来源暂时无法搜索",
        description: "当前来源搜索异常或超时，可以切换智能搜索、检查内容来源或稍后重试。",
      };
    }
    return {
      title: "当前来源没有找到",
      description: "当前来源已正常返回，但没有匹配内容。可以切换智能搜索或更换关键词。",
    };
  }

  if (!input.expandedToAllSources) {
    return {
      title: "首批来源没有找到",
      description: "可以继续搜索其余可用来源，或者更换关键词。",
    };
  }

  if (input.statuses.length > 0) {
    const summary = `已完成 ${input.statuses.length} 个来源，其中 ${successCount} 个正常返回${errorCount ? `，${errorCount} 个异常或超时` : ""}。`;
    if (successCount === 0 && errorCount > 0) {
      return {
        title: "可用来源暂时无法搜索",
        description: `${summary}可以检查内容来源或稍后重试。`,
      };
    }
    return {
      title: "没有找到匹配内容",
      description: `${summary}可以更换关键词后重试。`,
    };
  }

  return {
    title: "没有找到匹配内容",
    description: "当前没有可用的搜索结果，请检查内容来源或更换关键词。",
  };
}
