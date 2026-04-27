# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: tests/compare-urls.spec.ts >> URL Comparison: Preview vs Production >> Queso Dip
- Location: tests/compare-urls.spec.ts:81:9

# Error details

```
Error: Difference in content:
  • image paths (1 only in preview, 1 only in production)
  • text blocks (1 only in preview, 1 only in production)
  • links (1 only in preview, 1 only in production)
```

# Test source

```ts
  123 |         const diff = diffAnalyses(previewAnalysis, productionAnalysis);
  124 | 
  125 |         // Generate HTML report — one file per URL pair
  126 |         const reportPath = path.join(reportsDir, `${slug}-${timestamp}.html`);
  127 |         const html = generateReport(previewAnalysis, productionAnalysis, diff);
  128 |         fs.writeFileSync(reportPath, html, 'utf8');
  129 | 
  130 |         // Attach to Playwright test report for easy access in CI
  131 |         await testInfo.attach('Comparison Report (HTML)', {
  132 |           path: reportPath,
  133 |           contentType: 'text/html',
  134 |         });
  135 |         if (fs.existsSync(previewScreenshot)) {
  136 |           await testInfo.attach('Preview Screenshot', {
  137 |             path: previewScreenshot,
  138 |             contentType: 'image/png',
  139 |           });
  140 |         }
  141 |         if (fs.existsSync(productionScreenshot)) {
  142 |           await testInfo.attach('Production Screenshot', {
  143 |             path: productionScreenshot,
  144 |             contentType: 'image/png',
  145 |           });
  146 |         }
  147 | 
  148 |         // Console summary
  149 |         console.log('='.repeat(60));
  150 |         console.log(`COMPARISON SUMMARY — ${pair.name}`);
  151 |         console.log('='.repeat(60));
  152 |         console.log(`Total differences:    ${diff.totalDifferences}`);
  153 |         console.log(`Critical differences: ${diff.criticalDifferences}`);
  154 |         console.log(`Preview issues:       ${diff.consoleErrors.preview.length}`);
  155 |         console.log(`Production issues:    ${diff.consoleErrors.production.length}`);
  156 |         console.log('='.repeat(60));
  157 |         console.log(`\nReport saved to: ${reportPath}\n`);
  158 | 
  159 |         if (diff.criticalDifferences > 0) {
  160 |           console.log('⚠ CRITICAL DIFFERENCES FOUND:');
  161 |           if (diff.statusCode.isDifferent) {
  162 |             console.log(`  • HTTP Status: ${diff.statusCode.preview} (preview) vs ${diff.statusCode.production} (production)`);
  163 |           }
  164 |           if (diff.metadata.title.isDifferent) {
  165 |             console.log(`  • Title: "${diff.metadata.title.preview}" vs "${diff.metadata.title.production}"`);
  166 |           }
  167 |           if (diff.metadata.description.isDifferent) {
  168 |             console.log(`  • Meta description differs`);
  169 |           }
  170 |           if (diff.metadata.robots.isDifferent) {
  171 |             console.log(`  • Robots: "${diff.metadata.robots.preview}" vs "${diff.metadata.robots.production}"`);
  172 |           }
  173 |           console.log('');
  174 |         }
  175 | 
  176 |         // ── Test failure checks ───────────────────────────────────────────────
  177 |         // Marks the test as failed when a page is absent from one environment,
  178 |         // or when the Images / Content Comparison sections show differences.
  179 |         const testFailures: string[] = [];
  180 | 
  181 |         // "Only in" — page loads on one side but not the other
  182 |         const previewFailed    = Boolean(previewAnalysis.loadError) || previewAnalysis.statusCode >= 400;
  183 |         const productionFailed = Boolean(productionAnalysis.loadError) || productionAnalysis.statusCode >= 400;
  184 | 
  185 |         if (!previewFailed && productionFailed) {
  186 |           testInfo.annotations.push({ type: 'tag', description: 'only-in-preview' });
  187 |           testFailures.push(
  188 |             `Only in Preview — Production returned ${productionAnalysis.statusCode || 'error'}` +
  189 |             (productionAnalysis.loadError ? `: ${productionAnalysis.loadError}` : ''),
  190 |           );
  191 |         }
  192 |         if (previewFailed && !productionFailed) {
  193 |           testInfo.annotations.push({ type: 'tag', description: 'only-in-production' });
  194 |           testFailures.push(
  195 |             `Only in Production — Preview returned ${previewAnalysis.statusCode || 'error'}` +
  196 |             (previewAnalysis.loadError ? `: ${previewAnalysis.loadError}` : ''),
  197 |           );
  198 |         }
  199 | 
  200 |         // Images section + Content Comparison section
  201 |         const contentDiffDetails: string[] = [];
  202 |         if (diff.imagesCount.isDifferent)
  203 |           contentDiffDetails.push(`image count (preview: ${diff.imagesCount.preview}, production: ${diff.imagesCount.production})`);
  204 |         if (diff.imagesWithoutAlt.isDifferent)
  205 |           contentDiffDetails.push(`images missing alt (preview: ${diff.imagesWithoutAlt.preview}, production: ${diff.imagesWithoutAlt.production})`);
  206 |         if (diff.content.images.isDifferent)
  207 |           contentDiffDetails.push(`image paths (${diff.content.images.onlyInPreview.length} only in preview, ${diff.content.images.onlyInProduction.length} only in production)`);
  208 |         if (diff.content.text.isDifferent)
  209 |           contentDiffDetails.push(`text blocks (${diff.content.text.onlyInPreview.length} only in preview, ${diff.content.text.onlyInProduction.length} only in production)`);
  210 |         if (diff.content.links.isDifferent)
  211 |           contentDiffDetails.push(`links (${diff.content.links.onlyInPreview.length} only in preview, ${diff.content.links.onlyInProduction.length} only in production)`);
  212 |         if (diff.content.videos.isDifferent)
  213 |           contentDiffDetails.push(`videos (${diff.content.videos.onlyInPreview.length} only in preview, ${diff.content.videos.onlyInProduction.length} only in production)`);
  214 | 
  215 |         if (contentDiffDetails.length > 0) {
  216 |           testInfo.annotations.push({ type: 'tag', description: 'difference-in-content' });
  217 |           testFailures.push(
  218 |             `Difference in content:\n${contentDiffDetails.map((d) => `  • ${d}`).join('\n')}`,
  219 |           );
  220 |         }
  221 | 
  222 |         if (testFailures.length > 0) {
> 223 |           throw new Error(testFailures.join('\n'));
      |                 ^ Error: Difference in content:
  224 |         }
  225 |       } finally {
  226 |         await previewCtx.close();
  227 |         await productionCtx.close();
  228 |       }
  229 |     });
  230 |   }
  231 | });
  232 | 
```