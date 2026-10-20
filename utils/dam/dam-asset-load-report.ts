import { AssetIssue } from './dam-asset-load-checker';

export interface UrlWithIssues {
  url: string;
  assets: { issueType: AssetIssue['issueType']; label: string }[];
}

export interface DamAssetLoadReport {
  generatedAt: string;
  environment: string;
  urlsChecked: number;
  urlsWithIssues: UrlWithIssues[];
}

export function buildReport(
  environment: string,
  results: { url: string; issues: AssetIssue[] }[],
): DamAssetLoadReport {
  const urlsWithIssues = results
    .filter((r) => r.issues.length > 0)
    .map((r) => ({
      url: r.url,
      assets: r.issues.map((i) => ({ issueType: i.issueType, label: i.label })),
    }));

  return {
    generatedAt: new Date().toISOString(),
    environment,
    urlsChecked: results.length,
    urlsWithIssues,
  };
}
