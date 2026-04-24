import { parse as parseCss, walk as walkCss } from "css-tree";

import { average, clamp, isKebabCase, percent, round, severityRank, sum, toPercent, unique } from "./utils.js";

const DIMENSION_CONFIG = {
  classNaming: { name: "Class Naming Hygiene", weight: 20 },
  componentAdoption: { name: "Component Adoption", weight: 18 },
  cmsSchema: { name: "CMS Schema Maturity", weight: 18 },
  styleTokenization: { name: "Style Tokenization", weight: 12 },
  seoMetadata: { name: "SEO + Metadata Completeness", weight: 10 },
  assetHygiene: { name: "Asset Hygiene", weight: 8 },
  pageArchitecture: { name: "Page Architecture", weight: 8 },
  customCode: { name: "Custom Code Footprint", weight: 6 }
};

const AUTO_NAMED_CLASS_PATTERNS = [
  /^div-block(?:-\d+)?$/i,
  /^text-block(?:-\d+)?$/i,
  /^link-block(?:-\d+)?$/i,
  /^image(?:-\d+)?$/i,
  /^section(?:-\d+)?$/i,
  /^container(?:-\d+)?$/i,
  /^heading(?:-\d+)?$/i,
  /^paragraph(?:-\d+)?$/i,
  /^button(?:-\d+)?$/i,
  /^block(?:-\d+)?$/i,
  /^column(?:-\d+)?$/i,
  /^row(?:-\d+)?$/i
];

const AUTO_NAMED_ASSET_PATTERNS = [
  /^untitled[- ]?\d*$/i,
  /^img[_\- ]?\d+$/i,
  /^screenshot/i,
  /^image\d*$/i,
  /^download/i,
  /^dsc[_\- ]?\d+$/i,
  /^[a-f0-9]{8,}$/i
];

function dimensionBase(key, status = "complete") {
  const config = DIMENSION_CONFIG[key];
  return {
    key,
    name: config.name,
    weight: config.weight,
    status,
    score: 0,
    summary: "",
    metrics: {},
    issues: []
  };
}

function createIssue({
  dimensionKey,
  severity,
  title,
  detail,
  count = 1,
  recommendationId,
  mcpUseCaseBlocked,
  effortEstimate = "M"
}) {
  return {
    dimension: DIMENSION_CONFIG[dimensionKey].name,
    dimensionKey,
    severity,
    title,
    detail,
    count,
    recommendationId,
    mcpUseCaseBlocked,
    effortEstimate
  };
}

function matchesAny(value, patterns) {
  return patterns.some((pattern) => pattern.test(value));
}

function detectNamingConvention(values) {
  return values.some((value) =>
    /__|--|^(u|util|cc)-/i.test(value)
  );
}

function unwrapItems(input) {
  if (!input) {
    return [];
  }

  if (Array.isArray(input)) {
    return input;
  }

  for (const key of ["items", "pages", "collections", "assets", "components", "sites", "locales"]) {
    if (Array.isArray(input[key])) {
      return input[key];
    }
  }

  return [];
}

function traverseDom(node, visit) {
  if (!node || typeof node !== "object") {
    return;
  }

  visit(node);

  for (const key of ["children", "nodes", "items", "content"]) {
    if (Array.isArray(node[key])) {
      for (const child of node[key]) {
        traverseDom(child, visit);
      }
    }
  }

  for (const value of Object.values(node)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      traverseDom(value, visit);
    }
  }
}

function extractClassesFromDom(pageDoms = []) {
  const classes = [];
  let totalNodes = 0;
  let componentInstances = 0;
  const pageLevelCounts = [];

  for (const pageDom of pageDoms) {
    let pageComponentInstances = 0;
    traverseDom(pageDom, (node) => {
      totalNodes += 1;

      const classLikeValues = [
        ...(Array.isArray(node.classes) ? node.classes : []),
        ...(Array.isArray(node.classNames) ? node.classNames : []),
        ...(typeof node.className === "string" ? node.className.split(/\s+/) : []),
        ...(typeof node.class === "string" ? node.class.split(/\s+/) : []),
        ...(Array.isArray(node.properties?.classes) ? node.properties.classes : [])
      ]
        .map((value) => String(value).trim())
        .filter(Boolean);

      classes.push(...classLikeValues);

      if (
        node.type === "component-instance" ||
        node.type === "component" ||
        node.componentId ||
        node.componentInstanceId
      ) {
        componentInstances += 1;
        pageComponentInstances += 1;
      }
    });
    pageLevelCounts.push(pageComponentInstances);
  }

  return {
    classes,
    totalNodes,
    componentInstances,
    pageLevelCounts
  };
}

function normalizePage(page) {
  const seo = page.seo ?? {};
  const openGraph = page.openGraph ?? page.og ?? {};
  return {
    id: page.id ?? page._id ?? page.pageId,
    title: page.title ?? seo.title ?? page.name ?? "",
    seoTitle: seo.title ?? page.title ?? "",
    seoDescription: seo.description ?? page.description ?? "",
    ogTitle:
      openGraph.title ??
      page.ogTitle ??
      (openGraph.titleCopied ? seo.title : "") ??
      "",
    ogDescription:
      openGraph.description ??
      page.ogDescription ??
      (openGraph.descriptionCopied ? seo.description : "") ??
      "",
    slug: page.slug ?? page.path ?? "",
    draft: Boolean(page.draft),
    archived: Boolean(page.archived),
    parentId: page.parentId ?? page.parentPageId ?? null,
    isSystem: Boolean(page.isSystem ?? page.systemPage),
    customCode: page.customCode ?? null
  };
}

function scoreClassNaming(classes) {
  const dimension = dimensionBase("classNaming", classes.length ? "complete" : "unavailable");

  if (!classes.length) {
    dimension.summary = "No class inventory was available.";
    return dimension;
  }

  const uniqueClasses = unique(classes);
  const counts = new Map();
  for (const className of classes) {
    counts.set(className, (counts.get(className) ?? 0) + 1);
  }

  const semanticUnique = uniqueClasses.filter((className) => !matchesAny(className, AUTO_NAMED_CLASS_PATTERNS));
  const autoNamedUnique = uniqueClasses.length - semanticUnique.length;
  const singletonCount = uniqueClasses.filter((className) => (counts.get(className) ?? 0) === 1).length;
  const semanticRatio = percent(semanticUnique.length, uniqueClasses.length);
  const reuseDensity = classes.length / Math.max(uniqueClasses.length, 1);
  const conventionBonus = detectNamingConvention(uniqueClasses) ? 5 : 0;
  const singletonPenalty = Math.max(-15, -percent(singletonCount, uniqueClasses.length) * 30);
  const score = clamp(
    0,
    semanticRatio * 100 + Math.min(20, Math.max(0, (reuseDensity - 1) * 4)) + conventionBonus + singletonPenalty,
    100
  );

  dimension.score = round(score);
  dimension.metrics = {
    totalClassInstances: classes.length,
    uniqueClasses: uniqueClasses.length,
    semanticRatio: toPercent(semanticRatio),
    reuseDensity: round(reuseDensity, 2),
    singletonClasses: singletonCount,
    autoNamedClasses: autoNamedUnique,
    namingConventionDetected: detectNamingConvention(uniqueClasses)
  };
  dimension.summary =
    semanticRatio < 0.3
      ? "Class names are mostly auto-generated, so Claude will need to guess at element intent."
      : semanticRatio < 0.6
        ? "Class naming is mixed; Claude can work, but many edits will still require inspection."
        : "Class naming is generally descriptive enough for agent-driven changes.";

  if (semanticRatio < 0.3) {
    dimension.issues.push(
      createIssue({
        dimensionKey: dimension.key,
        severity: "Critical",
        title: "Auto-generated class naming dominates the site",
        detail: "Claude will struggle to target elements safely because most classes do not encode intent.",
        count: autoNamedUnique,
        recommendationId: "RENAME_AUTO_CLASSES",
        mcpUseCaseBlocked: "Prompt-driven element edits like 'make the primary CTA red'",
        effortEstimate: "L"
      })
    );
  } else if (semanticRatio < 0.6) {
    dimension.issues.push(
      createIssue({
        dimensionKey: dimension.key,
        severity: "High",
        title: "A significant share of classes are auto-named",
        detail: "Claude can operate, but it will need to visually inspect or guess for many elements.",
        count: autoNamedUnique,
        recommendationId: "RENAME_AUTO_CLASSES",
        mcpUseCaseBlocked: "Targeted design updates",
        effortEstimate: "M"
      })
    );
  } else if (semanticRatio < 0.8) {
    dimension.issues.push(
      createIssue({
        dimensionKey: dimension.key,
        severity: "Medium",
        title: "Class naming hygiene is inconsistent",
        detail: "The site is partially semantic, but enough one-off names remain to slow agent operations.",
        count: autoNamedUnique,
        recommendationId: "RENAME_AUTO_CLASSES",
        mcpUseCaseBlocked: "Bulk visual maintenance",
        effortEstimate: "M"
      })
    );
  }

  if (percent(singletonCount, uniqueClasses.length) > 0.5) {
    dimension.issues.push(
      createIssue({
        dimensionKey: dimension.key,
        severity: "Medium",
        title: "Many classes are one-off singletons",
        detail: "One-off styling patterns reduce reuse and increase the odds of Claude missing variants.",
        count: singletonCount,
        recommendationId: "EXTRACT_TO_COMPONENTS",
        mcpUseCaseBlocked: "Sitewide visual updates",
        effortEstimate: "M"
      })
    );
  }

  return dimension;
}

function scoreComponentAdoption(componentsInput, pageDomsInput, pageCount = 0) {
  const components = unwrapItems(componentsInput);
  const pageDoms = unwrapItems(pageDomsInput);
  const dimension = dimensionBase("componentAdoption", components.length || pageDoms.length ? "complete" : "unavailable");

  if (!components.length && !pageDoms.length) {
    dimension.summary = "No component inventory was available.";
    return dimension;
  }

  const { totalNodes, componentInstances, pageLevelCounts } = extractClassesFromDom(pageDoms);
  const pages = Math.max(pageCount, pageLevelCounts.length, 1);
  const avgInstanceDensity = percent(componentInstances, Math.max(totalNodes, 1));
  const reuseDepth = percent(componentInstances, Math.max(components.length, 1));
  const pagesWithZeroComponents = pageLevelCounts.filter((count) => count === 0).length + Math.max(0, pageCount - pageLevelCounts.length);
  const semanticNames = components.filter((component) => {
    const name = component.name ?? component.displayName ?? component.label ?? "";
    return name && !matchesAny(name, AUTO_NAMED_CLASS_PATTERNS);
  });
  const namingScore = percent(semanticNames.length, Math.max(components.length, 1)) * 100;
  const score =
    Math.min(100, avgInstanceDensity * 200) * 0.35 +
    Math.min(100, reuseDepth * 10) * 0.3 +
    (1 - pagesWithZeroComponents / pages) * 100 * 0.2 +
    namingScore * 0.15;

  dimension.score = round(clamp(0, score, 100));
  dimension.metrics = {
    componentsDefined: components.length,
    componentInstances,
    avgInstanceDensity: toPercent(avgInstanceDensity),
    avgReuseDepth: round(reuseDepth, 1),
    pagesWithZeroComponents,
    componentNamingQuality: round(namingScore, 1)
  };
  dimension.summary =
    components.length === 0
      ? "No components are defined, so every repeated change becomes a manual sweep."
      : dimension.score < 60
        ? "Component usage is present but too shallow to support reliable propagation."
        : "The site has enough component structure to support agent-led reuse.";

  if (components.length === 0) {
    dimension.issues.push(
      createIssue({
        dimensionKey: dimension.key,
        severity: "Critical",
        title: "No components are in use",
        detail: "Every repeated pattern must be edited instance by instance.",
        recommendationId: "EXTRACT_TO_COMPONENTS",
        mcpUseCaseBlocked: "Propagating updates across repeated UI patterns",
        effortEstimate: "L"
      })
    );
  }

  if (avgInstanceDensity < 0.05) {
    dimension.issues.push(
      createIssue({
        dimensionKey: dimension.key,
        severity: "High",
        title: "Component instance density is low",
        detail: "Most page structure is still duplicated rather than abstracted into reusable components.",
        count: componentInstances,
        recommendationId: "EXTRACT_TO_COMPONENTS",
        mcpUseCaseBlocked: "Sitewide CTA or section changes",
        effortEstimate: "L"
      })
    );
  }

  if (pagesWithZeroComponents / pages > 0.5) {
    dimension.issues.push(
      createIssue({
        dimensionKey: dimension.key,
        severity: "High",
        title: "More than half of pages have no components",
        detail: "Large parts of the site remain outside the reusable system.",
        count: pagesWithZeroComponents,
        recommendationId: "EXTRACT_TO_COMPONENTS",
        mcpUseCaseBlocked: "Consistent changes across templates",
        effortEstimate: "M"
      })
    );
  }

  return dimension;
}

function scoreCmsSchema(collectionsInput) {
  const collections = unwrapItems(collectionsInput).map((collection) => ({
    ...collection,
    fields: Array.isArray(collection.fields) ? collection.fields : []
  }));
  const dimension = dimensionBase("cmsSchema", collections.length ? "complete" : "unavailable");

  if (!collections.length) {
    dimension.summary = "No CMS collection schemas were available.";
    return dimension;
  }

  const collectionIds = new Set(collections.map((collection) => collection.id ?? collection._id));
  const fieldTypeCounts = collections.map((collection) => unique(collection.fields.map((field) => field.type)).length);
  const allFields = collections.flatMap((collection) => collection.fields);
  const referenceFields = allFields.filter((field) => /MultiReference|Reference/i.test(field.type ?? ""));
  const requiredFields = allFields.filter((field) => field.isRequired);
  const validationFields = allFields.filter((field) => field.validations && Object.keys(field.validations).length > 0);
  const helpTextFields = allFields.filter((field) => field.helpText);
  const brokenRefs = referenceFields.filter((field) => {
    const targetId = field.validations?.collectionId;
    return targetId && !collectionIds.has(targetId);
  });
  const collectionsMissingSlug = collections.filter((collection) =>
    !collection.fields.some((field) => String(field.slug ?? field.name ?? field.displayName).toLowerCase() === "slug")
  );
  const refDensity = percent(referenceFields.length, allFields.length);
  const score = clamp(
    0,
    Math.min(100, average(fieldTypeCounts) * 15) * 0.2 +
      Math.min(100, refDensity * 200) * 0.25 +
      percent(requiredFields.length, allFields.length) * 100 * 0.15 +
      percent(validationFields.length, allFields.length) * 100 * 0.15 +
      percent(helpTextFields.length, allFields.length) * 100 * 0.25 -
      brokenRefs.length * 5,
    100
  );

  dimension.score = round(score);
  dimension.metrics = {
    collections: collections.length,
    fields: allFields.length,
    avgFieldTypesPerCollection: round(average(fieldTypeCounts), 1),
    referenceFieldDensity: toPercent(refDensity),
    requiredFieldDiscipline: toPercent(percent(requiredFields.length, allFields.length)),
    validationCoverage: toPercent(percent(validationFields.length, allFields.length)),
    helpTextCoverage: toPercent(percent(helpTextFields.length, allFields.length)),
    brokenReferences: brokenRefs.length
  };
  dimension.summary =
    brokenRefs.length > 0
      ? "CMS relationships are broken, which makes agent-led publishing unsafe."
      : refDensity < 0.1
        ? "CMS collections exist, but they do not encode enough relational context for Claude."
        : "CMS schema quality is workable for structured publishing.";

  if (brokenRefs.length > 0) {
    dimension.issues.push(
      createIssue({
        dimensionKey: dimension.key,
        severity: "Critical",
        title: "Broken CMS references detected",
        detail: "At least one reference field points to a collection that does not resolve.",
        count: brokenRefs.length,
        recommendationId: "NORMALIZE_CMS_SCHEMA",
        mcpUseCaseBlocked: "Linking new items to related content",
        effortEstimate: "M"
      })
    );
  }

  if (referenceFields.length === 0) {
    dimension.issues.push(
      createIssue({
        dimensionKey: dimension.key,
        severity: "High",
        title: "Collections have no relational fields",
        detail: "Claude can insert content, but cannot understand content relationships across the site.",
        count: collections.length,
        recommendationId: "NORMALIZE_CMS_SCHEMA",
        mcpUseCaseBlocked: "Cross-linking new content to the correct entities",
        effortEstimate: "M"
      })
    );
  }

  if (percent(helpTextFields.length, allFields.length) < 0.2) {
    dimension.issues.push(
      createIssue({
        dimensionKey: dimension.key,
        severity: "Medium",
        title: "Most CMS fields lack help text",
        detail: "Field-level context is sparse, which weakens AI guidance during entry creation.",
        count: allFields.length - helpTextFields.length,
        recommendationId: "NORMALIZE_CMS_SCHEMA",
        mcpUseCaseBlocked: "Creating new CMS entries from prompts",
        effortEstimate: "M"
      })
    );
  }

  if (collectionsMissingSlug.length > 0) {
    dimension.issues.push(
      createIssue({
        dimensionKey: dimension.key,
        severity: "Medium",
        title: "Some collections lack an explicit slug field",
        detail: "Slug control appears inconsistent across the schema.",
        count: collectionsMissingSlug.length,
        recommendationId: "NORMALIZE_CMS_SCHEMA",
        mcpUseCaseBlocked: "Consistent publishing and routing",
        effortEstimate: "S"
      })
    );
  }

  return dimension;
}

function analyzeCss(cssText, styleguideDetected) {
  const metrics = {
    cssVarCount: 0,
    varUsagePct: 0,
    uniqueColors: 0,
    uniqueFontSizes: 0,
    fontFamilies: 0,
    styleguideDetected
  };

  if (!cssText) {
    return metrics;
  }

  const colors = unique((cssText.match(/#[0-9a-f]{3,8}/gi) ?? []).map((value) => value.toLowerCase()));
  const varUsages = cssText.match(/var\(/gi) ?? [];
  const fontSizes = unique((cssText.match(/font-size\s*:\s*([^;}{]+)/gi) ?? []).map((value) => value.split(":")[1].trim()));
  const fontFamilies = unique((cssText.match(/font-family\s*:\s*([^;}{]+)/gi) ?? []).map((value) => value.split(":")[1].trim()));
  let totalDeclarations = 0;
  let cssVarCount = 0;

  try {
    const ast = parseCss(cssText, { parseValue: true, positions: false });
    walkCss(ast, {
      visit: "Declaration",
      enter(node) {
        totalDeclarations += 1;
        if (node.property?.startsWith("--")) {
          cssVarCount += 1;
        }
      }
    });
  } catch {
    totalDeclarations = (cssText.match(/:/g) ?? []).length;
    cssVarCount = (cssText.match(/--[a-z0-9-_]+\s*:/gi) ?? []).length;
  }

  metrics.cssVarCount = cssVarCount;
  metrics.varUsagePct = percent(varUsages.length, Math.max(totalDeclarations, 1));
  metrics.uniqueColors = colors.length;
  metrics.uniqueFontSizes = fontSizes.length;
  metrics.fontFamilies = fontFamilies.length;

  return metrics;
}

function scoreStyleTokenization({ cssText, styleguideDetected }) {
  const dimension = dimensionBase("styleTokenization", cssText ? "complete" : "partial");
  const metrics = analyzeCss(cssText, Boolean(styleguideDetected));
  const score = clamp(
    0,
    Math.min(100, metrics.cssVarCount * 5) * 0.3 +
      Math.min(100, metrics.varUsagePct * 200) * 0.3 +
      Math.max(0, 100 - Math.max(0, metrics.uniqueColors - 12) * 2) * 0.2 +
      Math.max(0, 100 - Math.max(0, metrics.uniqueFontSizes - 8) * 4) * 0.2 +
      (metrics.fontFamilies > 3 ? Math.max(-20, -(metrics.fontFamilies - 3) * 10) : 0) +
      (metrics.styleguideDetected ? 10 : 0),
    100
  );

  dimension.score = round(score);
  dimension.metrics = {
    cssVarCount: metrics.cssVarCount,
    varUsagePct: toPercent(metrics.varUsagePct),
    uniqueColors: metrics.uniqueColors,
    uniqueFontSizes: metrics.uniqueFontSizes,
    fontFamilies: metrics.fontFamilies,
    styleguideDetected: metrics.styleguideDetected
  };
  dimension.summary =
    metrics.cssVarCount === 0
      ? "The site appears to rely on hardcoded styling rather than tokens."
      : metrics.varUsagePct === 0
        ? "CSS variables exist, but compiled styles are not actually consuming them."
        : "The styling system exposes at least some reusable tokens.";

  if (metrics.cssVarCount === 0) {
    dimension.issues.push(
      createIssue({
        dimensionKey: dimension.key,
        severity: "Critical",
        title: "No CSS variables were detected",
        detail: "Global visual changes will require searching hardcoded values instead of editing tokens.",
        recommendationId: "ESTABLISH_DESIGN_TOKENS",
        mcpUseCaseBlocked: "Atomic design changes like 'change the brand color to teal'",
        effortEstimate: "L"
      })
    );
  }

  if (metrics.uniqueColors > 50) {
    dimension.issues.push(
      createIssue({
        dimensionKey: dimension.key,
        severity: "High",
        title: "The color palette is highly fragmented",
        detail: "Too many unique color values suggest one-off styling and inconsistent token use.",
        count: metrics.uniqueColors,
        recommendationId: "ESTABLISH_DESIGN_TOKENS",
        mcpUseCaseBlocked: "Sitewide color system changes",
        effortEstimate: "M"
      })
    );
  }

  if (metrics.cssVarCount > 0 && metrics.varUsagePct === 0) {
    dimension.issues.push(
      createIssue({
        dimensionKey: dimension.key,
        severity: "High",
        title: "Variables are defined but not used",
        detail: "The token layer is decorative unless compiled styles consume it.",
        recommendationId: "ESTABLISH_DESIGN_TOKENS",
        mcpUseCaseBlocked: "Global style refactors",
        effortEstimate: "M"
      })
    );
  }

  if (!metrics.styleguideDetected) {
    dimension.issues.push(
      createIssue({
        dimensionKey: dimension.key,
        severity: "Low",
        title: "No style guide page was detected",
        detail: "A documented system page makes prompt-driven editing safer for operators and agents.",
        recommendationId: "BUILD_STYLE_GUIDE_PAGE",
        mcpUseCaseBlocked: "Operational consistency",
        effortEstimate: "M"
      })
    );
  }

  return dimension;
}

function scoreSeoMetadata(pagesInput) {
  const pages = unwrapItems(pagesInput).map(normalizePage).filter((page) => page.slug || page.seoTitle || page.title);
  const dimension = dimensionBase("seoMetadata", pages.length ? "complete" : "unavailable");

  if (!pages.length) {
    dimension.summary = "No page metadata was available.";
    return dimension;
  }

  const seoTitlePct = percent(pages.filter((page) => page.seoTitle).length, pages.length);
  const seoDescPct = percent(pages.filter((page) => page.seoDescription).length, pages.length);
  const ogTitlePct = percent(pages.filter((page) => page.ogTitle).length, pages.length);
  const ogDescPct = percent(pages.filter((page) => page.ogDescription).length, pages.length);
  const slugPct = percent(pages.filter((page) => isKebabCase(page.slug.replace(/^\/+/, ""))).length, pages.length);
  const titleLengthPct = percent(
    pages.filter((page) => page.seoTitle.length >= 30 && page.seoTitle.length <= 60).length,
    pages.length
  );
  const descLengthPct = percent(
    pages.filter((page) => page.seoDescription.length >= 120 && page.seoDescription.length <= 160).length,
    pages.length
  );

  dimension.score = round(
    seoTitlePct * 25 +
      seoDescPct * 25 +
      ogTitlePct * 15 +
      ogDescPct * 15 +
      slugPct * 10 +
      titleLengthPct * 5 +
      descLengthPct * 5
  );
  dimension.metrics = {
    pages: pages.length,
    seoTitleCoverage: toPercent(seoTitlePct),
    seoDescriptionCoverage: toPercent(seoDescPct),
    ogTitleCoverage: toPercent(ogTitlePct),
    ogDescriptionCoverage: toPercent(ogDescPct),
    slugConsistency: toPercent(slugPct),
    titleLengthCompliance: toPercent(titleLengthPct),
    descriptionLengthCompliance: toPercent(descLengthPct)
  };
  dimension.summary =
    dimension.score < 60
      ? "Metadata coverage is incomplete enough that Claude-first audit and fix workflows will stall."
      : "Metadata coverage is reasonably mature for agent-led maintenance.";

  if (seoTitlePct < 0.8 || seoDescPct < 0.8) {
    dimension.issues.push(
      createIssue({
        dimensionKey: dimension.key,
        severity: seoTitlePct < 0.6 || seoDescPct < 0.6 ? "High" : "Medium",
        title: "SEO coverage is incomplete",
        detail: "A meaningful share of pages are missing title or description fields.",
        count: Math.round(pages.length * (1 - Math.min(seoTitlePct, seoDescPct))),
        recommendationId: "BACKFILL_SEO_METADATA",
        mcpUseCaseBlocked: "Bulk SEO and metadata remediation",
        effortEstimate: "M"
      })
    );
  }

  if (ogTitlePct < 0.8 || ogDescPct < 0.8) {
    dimension.issues.push(
      createIssue({
        dimensionKey: dimension.key,
        severity: "Medium",
        title: "Open Graph fields are inconsistently populated",
        detail: "Social preview hygiene is uneven across the sampled pages.",
        count: Math.round(pages.length * (1 - Math.min(ogTitlePct, ogDescPct))),
        recommendationId: "BACKFILL_SEO_METADATA",
        mcpUseCaseBlocked: "Social metadata fixes",
        effortEstimate: "S"
      })
    );
  }

  return dimension;
}

function scoreAssetHygiene(assetsInput) {
  const assets = unwrapItems(assetsInput);
  const dimension = dimensionBase("assetHygiene", assets.length ? "complete" : "unavailable");

  if (!assets.length) {
    dimension.summary = "No asset inventory was available.";
    return dimension;
  }

  const withAlt = assets.filter((asset) => asset.altText).length;
  const goodNames = assets.filter((asset) => {
    const name = asset.displayName ?? asset.fileName ?? asset.name ?? "";
    const stem = name.replace(/\.[a-z0-9]+$/i, "");
    return stem && !matchesAny(stem, AUTO_NAMED_ASSET_PATTERNS);
  }).length;
  const modernFormats = assets.filter((asset) => /\.(webp|avif)$/i.test(asset.fileName ?? asset.displayName ?? asset.url ?? "")).length;
  const score = percent(withAlt, assets.length) * 50 + percent(goodNames, assets.length) * 35 + Math.min(15, percent(modernFormats, assets.length) * 100 * 0.15);

  dimension.score = round(score);
  dimension.metrics = {
    assets: assets.length,
    altTextCoverage: toPercent(percent(withAlt, assets.length)),
    displayNameQuality: toPercent(percent(goodNames, assets.length)),
    modernFormatAdoption: toPercent(percent(modernFormats, assets.length))
  };
  dimension.summary =
    dimension.score < 60
      ? "Asset naming and alt text coverage are too weak for reliable prompt-based asset selection."
      : "Asset inventory is mostly usable for agent-led insertion and remediation.";

  if (percent(withAlt, assets.length) < 0.8) {
    dimension.issues.push(
      createIssue({
        dimensionKey: dimension.key,
        severity: percent(withAlt, assets.length) < 0.5 ? "High" : "Medium",
        title: "Alt text coverage is incomplete",
        detail: "Claude will have too little semantic context to choose the correct image consistently.",
        count: assets.length - withAlt,
        recommendationId: "BACKFILL_ALT_TEXT",
        mcpUseCaseBlocked: "Image selection and accessibility remediation",
        effortEstimate: "M"
      })
    );
  }

  if (percent(goodNames, assets.length) < 0.7) {
    dimension.issues.push(
      createIssue({
        dimensionKey: dimension.key,
        severity: "Medium",
        title: "Many asset filenames are non-descriptive",
        detail: "Unhelpful filenames force Claude to guess when selecting or swapping images.",
        count: assets.length - goodNames,
        recommendationId: "RENAME_ASSETS",
        mcpUseCaseBlocked: "Asset insertion from natural-language prompts",
        effortEstimate: "S"
      })
    );
  }

  if (percent(modernFormats, assets.length) < 0.5) {
    dimension.issues.push(
      createIssue({
        dimensionKey: dimension.key,
        severity: "Low",
        title: "Modern image formats are not widely used",
        detail: "Legacy formats dominate the library.",
        count: assets.length - modernFormats,
        recommendationId: "MIGRATE_TO_MODERN_FORMATS",
        mcpUseCaseBlocked: "Performance-oriented media refreshes",
        effortEstimate: "S"
      })
    );
  }

  return dimension;
}

function scorePageArchitecture(pagesInput, siteInput) {
  const pages = unwrapItems(pagesInput).map(normalizePage);
  const dimension = dimensionBase("pageArchitecture", pages.length ? "complete" : "unavailable");

  if (!pages.length) {
    dimension.summary = "No page inventory was available.";
    return dimension;
  }

  const pageMap = new Map(pages.map((page) => [page.id, page]));
  const depthForPage = (page) => {
    let depth = 0;
    let current = page;
    const visited = new Set();
    while (current?.parentId && pageMap.has(current.parentId) && !visited.has(current.parentId)) {
      visited.add(current.parentId);
      depth += 1;
      current = pageMap.get(current.parentId);
    }
    return depth;
  };

  const slugPct = percent(pages.filter((page) => isKebabCase(page.slug.replace(/^\/+/, ""))).length, pages.length);
  const draftPct = percent(pages.filter((page) => page.draft).length, pages.length);
  const archivePct = percent(pages.filter((page) => page.archived).length, pages.length);
  const maxDepth = Math.max(...pages.map(depthForPage), 0);
  const locales = unwrapItems(siteInput?.locales ?? siteInput?.siteLocales);
  const primaryLocale = locales.find((locale) => locale.primary) ?? locales[0];
  const localeHealthy = !primaryLocale || primaryLocale.enabled !== false;
  const has404 = pages.some((page) => /404/.test(page.slug) || /404/i.test(page.title));
  const hasPassword = pages.some((page) => /password/.test(page.slug) || /password/i.test(page.title));
  const systemPages = pages.filter((page) => page.isSystem).length;

  const hygieneScore = (value) => {
    if (value <= 0.05) {
      return 100;
    }
    if (value >= 0.2) {
      return 0;
    }
    return round(100 - ((value - 0.05) / 0.15) * 100, 1);
  };

  dimension.score = round(
    slugPct * 100 * 0.3 +
      hygieneScore(draftPct) * 0.2 +
      hygieneScore(archivePct) * 0.15 +
      Math.max(0, 100 - Math.max(0, maxDepth - 3) * 20) * 0.1 +
      (localeHealthy ? 100 : 20) * 0.1 +
      ((has404 ? 50 : 0) + (hasPassword ? 50 : 0)) * 0.05 +
      Math.max(20, 100 - percent(systemPages, pages.length) * 100) * 0.1
  );
  dimension.metrics = {
    pages: pages.length,
    slugConsistency: toPercent(slugPct),
    draftPct: toPercent(draftPct),
    archivePct: toPercent(archivePct),
    maxFolderDepth: maxDepth,
    localesConfigured: locales.length,
    primaryLocaleHealthy: localeHealthy,
    systemPages
  };
  dimension.summary =
    dimension.score < 60
      ? "Page inventory hygiene is uneven enough to create ambiguity for agent-driven navigation."
      : "Page structure is mostly clean enough for Claude to navigate safely.";

  if (draftPct > 0.2 || archivePct > 0.2) {
    dimension.issues.push(
      createIssue({
        dimensionKey: dimension.key,
        severity: draftPct > 0.35 || archivePct > 0.35 ? "High" : "Medium",
        title: "Draft and archived page clutter is high",
        detail: "Too many stale pages increase ambiguity around which content Claude should operate on.",
        count: Math.round((draftPct + archivePct) * pages.length),
        recommendationId: "PRUNE_DRAFTS_ARCHIVES",
        mcpUseCaseBlocked: "Publishing or updating the right page version",
        effortEstimate: "S"
      })
    );
  }

  if (!localeHealthy) {
    dimension.issues.push(
      createIssue({
        dimensionKey: dimension.key,
        severity: "High",
        title: "Primary locale appears misconfigured",
        detail: "Locale configuration suggests the published primary locale is disabled.",
        recommendationId: "PRUNE_DRAFTS_ARCHIVES",
        mcpUseCaseBlocked: "Safe multi-locale publishing",
        effortEstimate: "S"
      })
    );
  }

  return dimension;
}

function normalizeCustomCode(customCode) {
  if (!customCode) {
    return [];
  }

  const values = [];
  for (const value of Object.values(customCode)) {
    if (typeof value === "string" && value.trim()) {
      values.push(value);
    }
    if (Array.isArray(value)) {
      values.push(...value.filter((entry) => typeof entry === "string" && entry.trim()));
    }
  }
  return values;
}

function scoreCustomCode({ customCodeInput, registeredScriptsInput, pagesInput, fallbackThirdPartyEmbeds = [], partial = false }) {
  const dimension = dimensionBase("customCode", partial ? "partial" : "complete");
  const registeredScripts = unwrapItems(registeredScriptsInput);
  const pages = unwrapItems(pagesInput).map(normalizePage);
  const inlineBlocks = normalizeCustomCode(customCodeInput);
  const pageOverrides = pages.filter((page) => page.customCode).length;
  const thirdPartyCount = unique([
    ...fallbackThirdPartyEmbeds,
    ...registeredScripts
      .map((script) => script.name ?? script.src ?? script.url ?? "")
      .filter(Boolean)
  ]).length;
  const score = clamp(0, 100 - inlineBlocks.length * 5 - thirdPartyCount * 3 - pageOverrides * 2, 100);

  dimension.score = round(score);
  dimension.metrics = {
    inlineCustomCodeBlocks: inlineBlocks.length,
    registeredScripts: registeredScripts.length,
    pageOverrides,
    thirdPartyEmbeds: thirdPartyCount
  };
  dimension.summary =
    partial
      ? "Custom code was only partially observable, so this score uses DOM and script fallbacks."
      : score < 70
        ? "A notable share of site behavior lives outside MCP-controlled structures."
        : "Custom code footprint looks manageable for agent operations.";

  if (inlineBlocks.length > registeredScripts.length) {
    dimension.issues.push(
      createIssue({
        dimensionKey: dimension.key,
        severity: "Medium",
        title: "Inline custom code outweighs registered scripts",
        detail: "Inline scripts are harder to reason about and more likely to break after agent edits.",
        count: inlineBlocks.length,
        recommendationId: "CONSOLIDATE_CUSTOM_CODE",
        mcpUseCaseBlocked: "Safely editing markup around embedded behavior",
        effortEstimate: "M"
      })
    );
  }

  if (thirdPartyCount > 3) {
    dimension.issues.push(
      createIssue({
        dimensionKey: dimension.key,
        severity: "Medium",
        title: "Multiple third-party embed zones were detected",
        detail: "These integrations create no-go zones Claude should not refactor blindly.",
        count: thirdPartyCount,
        recommendationId: "REPLACE_THIRD_PARTY_EMBEDS",
        mcpUseCaseBlocked: "Safe structural edits near embeds",
        effortEstimate: "S"
      })
    );
  }

  return dimension;
}

function buildRecommendations(result) {
  const recommendations = [];
  const byKey = new Map(result.dimensions.map((dimension) => [dimension.key, dimension]));
  const getMetric = (key, metricName, fallback = 0) => byKey.get(key)?.metrics?.[metricName] ?? fallback;

  const classMetrics = byKey.get("classNaming")?.metrics ?? {};
  if ((classMetrics.semanticRatio ?? 100) < 80) {
    recommendations.push({
      id: "RENAME_AUTO_CLASSES",
      title: "Rename auto-named classes to semantic names",
      hours: round((classMetrics.autoNamedClasses ?? 0) * 0.1, 1),
      phase: "Foundation"
    });
  }

  const componentMetrics = byKey.get("componentAdoption")?.metrics ?? {};
  const repeatedPatternsDetected = Math.max(
    0,
    Math.round((componentMetrics.pagesWithZeroComponents ?? 0) + (classMetrics.singletonClasses ?? 0) / 10)
  );
  if (repeatedPatternsDetected > 10 || (componentMetrics.componentsDefined ?? 0) === 0) {
    recommendations.push({
      id: "EXTRACT_TO_COMPONENTS",
      title: "Extract repeated patterns into components",
      hours: round(Math.max(6, repeatedPatternsDetected * 1.5), 1),
      phase: "Foundation"
    });
  }

  const styleMetrics = byKey.get("styleTokenization")?.metrics ?? {};
  if ((styleMetrics.cssVarCount ?? 0) < 10) {
    recommendations.push({
      id: "ESTABLISH_DESIGN_TOKENS",
      title: "Convert hardcoded styles into reusable CSS variables",
      hours: round(4 + Math.max(10, styleMetrics.uniqueColors ?? 0) * 0.05, 1),
      phase: "Foundation"
    });
  }

  const cmsMetrics = byKey.get("cmsSchema")?.metrics ?? {};
  if ((cmsMetrics.referenceFieldDensity ?? 100) < 10 || (cmsMetrics.helpTextCoverage ?? 100) < 20) {
    recommendations.push({
      id: "NORMALIZE_CMS_SCHEMA",
      title: "Add references, validations, and help text to CMS collections",
      hours: round((cmsMetrics.collections ?? 0) * 2, 1),
      phase: "Foundation"
    });
  }

  if (!styleMetrics.styleguideDetected) {
    recommendations.push({
      id: "BUILD_STYLE_GUIDE_PAGE",
      title: "Create a style guide page documenting tokens and patterns",
      hours: 6,
      phase: "Optimization"
    });
  }

  const seoMetrics = byKey.get("seoMetadata")?.metrics ?? {};
  const seoCoverage = Math.min(seoMetrics.seoTitleCoverage ?? 100, seoMetrics.seoDescriptionCoverage ?? 100);
  if (seoCoverage < 80) {
    recommendations.push({
      id: "BACKFILL_SEO_METADATA",
      title: "Populate missing SEO and Open Graph metadata",
      hours: round(((seoMetrics.pages ?? 0) * (100 - seoCoverage) / 100) * 0.05, 1),
      phase: "Optimization"
    });
  }

  const assetMetrics = byKey.get("assetHygiene")?.metrics ?? {};
  if ((assetMetrics.altTextCoverage ?? 100) < 80) {
    recommendations.push({
      id: "BACKFILL_ALT_TEXT",
      title: "Backfill missing alt text across the asset library",
      hours: round(((assetMetrics.assets ?? 0) * (100 - (assetMetrics.altTextCoverage ?? 100)) / 100) * 0.03, 1),
      phase: "Optimization"
    });
  }

  if ((assetMetrics.displayNameQuality ?? 100) < 70) {
    recommendations.push({
      id: "RENAME_ASSETS",
      title: "Rename auto-generated asset filenames",
      hours: round(((assetMetrics.assets ?? 0) * (100 - (assetMetrics.displayNameQuality ?? 100)) / 100) * 0.05, 1),
      phase: "Optimization"
    });
  }

  if ((assetMetrics.modernFormatAdoption ?? 100) < 50) {
    recommendations.push({
      id: "MIGRATE_TO_MODERN_FORMATS",
      title: "Convert legacy image assets to modern formats",
      hours: round(((assetMetrics.assets ?? 0) * (100 - (assetMetrics.modernFormatAdoption ?? 100)) / 100) * 0.05, 1),
      phase: "Enablement"
    });
  }

  const architectureMetrics = byKey.get("pageArchitecture")?.metrics ?? {};
  if ((architectureMetrics.draftPct ?? 0) > 20 || (architectureMetrics.archivePct ?? 0) > 20) {
    recommendations.push({
      id: "PRUNE_DRAFTS_ARCHIVES",
      title: "Clean up stale drafts and archived pages",
      hours: 1,
      phase: "Foundation"
    });
  }

  const customCodeMetrics = byKey.get("customCode")?.metrics ?? {};
  if ((customCodeMetrics.inlineCustomCodeBlocks ?? 0) > (customCodeMetrics.registeredScripts ?? 0)) {
    recommendations.push({
      id: "CONSOLIDATE_CUSTOM_CODE",
      title: "Move unmanaged inline scripts into registered scripts where possible",
      hours: round((customCodeMetrics.inlineCustomCodeBlocks ?? 0) * 2, 1),
      phase: "Optimization"
    });
  }

  if ((customCodeMetrics.thirdPartyEmbeds ?? 0) > 3) {
    recommendations.push({
      id: "REPLACE_THIRD_PARTY_EMBEDS",
      title: "Document and isolate third-party embed no-go zones",
      hours: 0,
      phase: "Enablement"
    });
  }

  return recommendations.filter((recommendation) => recommendation.hours > 0 || recommendation.id === "REPLACE_THIRD_PARTY_EMBEDS");
}

function implementationBand(hours) {
  if (hours < 60) {
    return { band: "Light", priceRange: "$5,000-$10,000", timeline: "1-2 weeks" };
  }
  if (hours < 150) {
    return { band: "Medium", priceRange: "$10,000-$25,000", timeline: "3-4 weeks" };
  }
  if (hours < 300) {
    return { band: "Heavy", priceRange: "$25,000-$50,000", timeline: "5-8 weeks" };
  }
  return { band: "Foundational", priceRange: "$50,000+", timeline: "Custom" };
}

function overallBand(score) {
  if (score >= 90) {
    return "Excellent";
  }
  if (score >= 75) {
    return "Good";
  }
  if (score >= 60) {
    return "Fair";
  }
  if (score >= 40) {
    return "Poor";
  }
  return "Critical";
}

function readinessMessage(score) {
  if (score >= 90) {
    return "This site already looks very workable for agent-led Webflow operations.";
  }
  if (score >= 75) {
    return "This site is in good shape, with a few fixes needed before MCP workflows feel reliable.";
  }
  if (score >= 60) {
    return "This site has a usable foundation, but several gaps will slow Claude down or create inconsistency.";
  }
  if (score >= 40) {
    return "This site will need a meaningful cleanup before Claude can operate on it confidently.";
  }
  return "This site is not yet structured well for safe MCP-driven changes.";
}

function scoreLabel(score) {
  if (score >= 80) {
    return "Strong";
  }
  if (score >= 60) {
    return "Mixed";
  }
  return "Needs attention";
}

function dimensionProofPoint(dimension) {
  switch (dimension.key) {
    case "classNaming":
      return `${dimension.metrics.semanticRatio ?? 0}% of sampled classes appear semantic, with ${dimension.metrics.autoNamedClasses ?? 0} auto-named classes detected.`;
    case "styleTokenization":
      return `Found ${dimension.metrics.cssVarCount ?? 0} CSS variables, ${dimension.metrics.uniqueColors ?? 0} unique colors, and ${dimension.metrics.styleguideDetected ? "a" : "no"} visible style guide page.`;
    case "seoMetadata":
      return `${dimension.metrics.seoTitleCoverage ?? 0}% of sampled pages have SEO titles and ${dimension.metrics.seoDescriptionCoverage ?? 0}% have descriptions.`;
    case "componentAdoption":
      return `${dimension.metrics.componentsDefined ?? 0} components and ${dimension.metrics.componentInstances ?? 0} instances were detected across the site.`;
    case "cmsSchema":
      return `${dimension.metrics.collections ?? 0} collections were reviewed, with ${dimension.metrics.referenceFieldDensity ?? 0}% relational fields and ${dimension.metrics.helpTextCoverage ?? 0}% help text coverage.`;
    case "assetHygiene":
      return `${dimension.metrics.altTextCoverage ?? 0}% of assets have alt text and ${dimension.metrics.displayNameQuality ?? 0}% have descriptive names.`;
    case "pageArchitecture":
      return `${dimension.metrics.slugConsistency ?? 0}% of sampled slugs are clean, with ${dimension.metrics.draftPct ?? 0}% drafts and ${dimension.metrics.archivePct ?? 0}% archived pages.`;
    case "customCode":
      return `${dimension.metrics.inlineCustomCodeBlocks ?? 0} inline custom code blocks and ${dimension.metrics.thirdPartyEmbeds ?? 0} third-party embed zones were detected.`;
    default:
      return dimension.summary;
  }
}

function dimensionActionHint(dimension) {
  const [issue] = dimension.issues;
  if (issue?.recommendationId) {
    return issue.title;
  }

  switch (dimension.key) {
    case "classNaming":
      return "Tighten class naming so prompts can target the right elements.";
    case "styleTokenization":
      return "Move more styling into reusable tokens and reduce one-off values.";
    case "seoMetadata":
      return "Backfill missing page metadata and normalize title and description lengths.";
    default:
      return "Review this area in the full audit for more specific remediation steps.";
  }
}

function buildConsumerBreakdown(scoredDimensions) {
  const ordered = [...scoredDimensions]
    .filter((dimension) => dimension.status !== "unavailable")
    .sort((left, right) => right.score - left.score);
  const strongest = ordered[0] ?? null;
  const weakest = ordered[ordered.length - 1] ?? null;
  const whatsWorking = ordered
    .filter((dimension) => dimension.score >= 70)
    .slice(0, 3)
    .map((dimension) => ({
      dimension: dimension.name,
      score: dimension.score,
      label: scoreLabel(dimension.score),
      summary: dimension.summary,
      proof: dimensionProofPoint(dimension)
    }));
  const needsAttention = [...ordered]
    .reverse()
    .filter((dimension) => dimension.score < 75)
    .slice(0, 3)
    .map((dimension) => ({
      dimension: dimension.name,
      score: dimension.score,
      label: scoreLabel(dimension.score),
      summary: dimension.summary,
      proof: dimensionProofPoint(dimension),
      nextStep: dimensionActionHint(dimension)
    }));

  return {
    strongestDimension: strongest
      ? {
          dimension: strongest.name,
          score: strongest.score,
          summary: strongest.summary,
          proof: dimensionProofPoint(strongest)
        }
      : null,
    weakestDimension: weakest
      ? {
          dimension: weakest.name,
          score: weakest.score,
          summary: weakest.summary,
          proof: dimensionProofPoint(weakest),
          nextStep: dimensionActionHint(weakest)
        }
      : null,
    whatsWorking,
    needsAttention,
    dimensionCards: ordered.map((dimension) => ({
      dimension: dimension.name,
      key: dimension.key,
      score: dimension.score,
      label: scoreLabel(dimension.score),
      summary: dimension.summary,
      proof: dimensionProofPoint(dimension),
      nextStep: dimensionActionHint(dimension)
    }))
  };
}

function finalizeAudit(dimensions) {
  const scoredDimensions = dimensions.filter((dimension) => dimension.status !== "unavailable");
  const totalWeight = sum(scoredDimensions.map((dimension) => dimension.weight));
  const weightedScore =
    totalWeight === 0
      ? 0
      : sum(scoredDimensions.map((dimension) => dimension.score * dimension.weight)) / totalWeight;
  const allIssues = scoredDimensions
    .flatMap((dimension) => dimension.issues.map((issue) => ({ ...issue, dimensionWeight: dimension.weight })))
    .sort((left, right) => {
      const leftScore = severityRank(left.severity) * left.dimensionWeight * Math.max(left.count ?? 1, 1);
      const rightScore = severityRank(right.severity) * right.dimensionWeight * Math.max(right.count ?? 1, 1);
      return rightScore - leftScore;
    });
  const recommendations = buildRecommendations({ dimensions: scoredDimensions, issues: allIssues });
  const totalHours = round(sum(recommendations.map((recommendation) => recommendation.hours)));
  const investment = implementationBand(totalHours);
  const wins = scoredDimensions
    .filter((dimension) => dimension.score >= 80)
    .sort((left, right) => right.score - left.score)
    .slice(0, 5)
    .map((dimension) => `${dimension.name}: ${dimension.summary}`);

  return {
    overallScore: round(weightedScore),
    band: overallBand(weightedScore),
    readinessMessage: readinessMessage(weightedScore),
    dimensions: dimensions.sort((left, right) => right.weight - left.weight),
    topIssues: allIssues.slice(0, 5),
    issues: allIssues,
    wins,
    recommendations,
    roadmap: {
      phase1: recommendations.filter((recommendation) => recommendation.phase === "Foundation"),
      phase2: recommendations.filter((recommendation) => recommendation.phase === "Optimization"),
      phase3: recommendations.filter((recommendation) => recommendation.phase === "Enablement"),
      totalHours,
      ...investment,
      auditFeeCredit: "100% credit if implementation is signed within 30 days"
    }
  };
}

export function buildSnapshotAudit({ crawl }) {
  const dimensions = [
    scoreClassNaming(crawl.classes ?? []),
    scoreStyleTokenization({ cssText: crawl.cssText, styleguideDetected: crawl.styleguideUrl }),
    scoreSeoMetadata(crawl.pages ?? []),
    scoreAssetHygiene(crawl.assets ?? []),
    scorePageArchitecture(crawl.pages ?? [], null),
    scoreCustomCode({
      customCodeInput: { inline: Array.from({ length: crawl.inlineScriptCount ?? 0 }, () => "<script></script>") },
      registeredScriptsInput: [],
      pagesInput: crawl.pages ?? [],
      fallbackThirdPartyEmbeds: crawl.thirdPartyEmbeds ?? [],
      partial: true
    })
  ];

  const finalized = finalizeAudit(dimensions);
  return {
    ...finalized,
    auditType: "snapshot",
    dimensions,
    topIssues: finalized.topIssues.slice(0, 3),
    coverage: {
      pagesSampled: crawl.pages?.length ?? 0,
      dimensionsScored: finalized.dimensions.filter((dimension) => dimension.status !== "unavailable").length,
      checkedAreas: finalized.dimensions
        .filter((dimension) => dimension.status !== "unavailable")
        .map((dimension) => dimension.name)
    },
    consumerBreakdown: buildConsumerBreakdown(finalized.dimensions)
  };
}

export function buildFullAudit({
  crawl,
  site,
  pages,
  pageDoms,
  collections,
  components,
  assets,
  customCode,
  registeredScripts,
  partials = {}
}) {
  const normalizedPages = unwrapItems(pages);
  const dimensions = [
    scoreClassNaming((pageDoms?.length ? extractClassesFromDom(unwrapItems(pageDoms)).classes : crawl.classes) ?? []),
    scoreComponentAdoption(components, pageDoms, normalizedPages.length),
    scoreCmsSchema(collections),
    scoreStyleTokenization({ cssText: crawl.cssText, styleguideDetected: crawl.styleguideUrl }),
    scoreSeoMetadata(normalizedPages.length ? normalizedPages : crawl.pages),
    scoreAssetHygiene(assets),
    scorePageArchitecture(normalizedPages, site),
    scoreCustomCode({
      customCodeInput: customCode,
      registeredScriptsInput: registeredScripts,
      pagesInput: normalizedPages,
      fallbackThirdPartyEmbeds: crawl.thirdPartyEmbeds,
      partial: Boolean(partials.customCode)
    })
  ];

  for (const dimension of dimensions) {
    if (partials[dimension.key]) {
      dimension.status = "partial";
    }
  }

  return {
    ...finalizeAudit(dimensions),
    auditType: "paid"
  };
}

export { DIMENSION_CONFIG, implementationBand, overallBand };
