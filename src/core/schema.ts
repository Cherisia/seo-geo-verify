import type { Profile } from "./types.js";
export interface SchemaDefinition {
  label: string;
  required: string[];
  recommended: string[];
  major?: boolean;
  rich?: boolean;
  family?: string;
}
/** Versioned scoring criteria, not universal Schema.org or Google required properties. */
export const schemaRegistry: Record<string, SchemaDefinition> = {
  Organization: {
    label: "조직·회사",
    required: ["name", "url"],
    recommended: ["logo", "description", "address", "sameAs", "contactPoint"],
    major: true,
    rich: true,
    family: "publisher",
  },
  Person: {
    label: "인물",
    required: ["name"],
    recommended: [
      "url",
      "image",
      "jobTitle",
      "sameAs",
      "description",
      "worksFor",
    ],
    major: true,
  },
  WebSite: {
    label: "웹사이트",
    required: ["name", "url"],
    recommended: ["publisher", "inLanguage", "description", "potentialAction"],
    major: true,
    rich: true,
  },
  WebPage: {
    label: "웹페이지",
    required: ["name", "url"],
    recommended: [
      "description",
      "isPartOf",
      "breadcrumb",
      "inLanguage",
      "datePublished",
      "dateModified",
      "primaryImageOfPage",
    ],
    major: true,
  },
  LocalBusiness: {
    label: "지역 비즈니스",
    required: ["name", "address"],
    recommended: [
      "telephone",
      "url",
      "image",
      "openingHours",
      "geo",
      "priceRange",
      "aggregateRating",
    ],
    major: true,
    rich: true,
    family: "local",
  },
  PostalAddress: {
    label: "주소",
    required: ["streetAddress", "addressLocality"],
    recommended: ["addressRegion", "postalCode", "addressCountry"],
  },
  BreadcrumbList: {
    label: "이동경로",
    required: ["itemListElement"],
    recommended: [],
    major: true,
    rich: true,
  },
  Service: {
    label: "서비스",
    required: ["name"],
    recommended: [
      "description",
      "provider",
      "serviceType",
      "areaServed",
      "url",
      "offers",
    ],
  },
  Product: {
    label: "상품",
    required: ["name", "image"],
    recommended: [
      "description",
      "brand",
      "sku",
      "offers",
      "aggregateRating",
      "review",
    ],
    major: true,
    rich: true,
  },
  Offer: {
    label: "판매 정보",
    required: ["price", "priceCurrency"],
    recommended: ["availability", "url", "priceValidUntil", "itemCondition"],
    rich: true,
  },
  Article: {
    label: "아티클",
    required: ["headline", "image", "datePublished"],
    recommended: [
      "author",
      "publisher",
      "dateModified",
      "mainEntityOfPage",
      "description",
    ],
    major: true,
    rich: true,
    family: "article",
  },
  BlogPosting: {
    label: "블로그 글",
    required: ["headline", "image", "datePublished"],
    recommended: [
      "author",
      "publisher",
      "dateModified",
      "mainEntityOfPage",
      "description",
    ],
    major: true,
    rich: true,
    family: "article",
  },
  NewsArticle: {
    label: "뉴스 기사",
    required: ["headline", "image", "datePublished"],
    recommended: [
      "author",
      "publisher",
      "dateModified",
      "mainEntityOfPage",
      "description",
    ],
    major: true,
    rich: true,
    family: "article",
  },
  FAQPage: {
    label: "FAQ 페이지",
    required: ["mainEntity"],
    recommended: [],
    major: true,
    rich: true,
    family: "faq",
  },
  QAPage: {
    label: "Q&A 페이지",
    required: ["mainEntity"],
    recommended: [],
    major: true,
    rich: true,
    family: "faq",
  },
  Question: {
    label: "질문",
    required: ["name", "acceptedAnswer"],
    recommended: [],
    rich: true,
  },
  Answer: {
    label: "답변",
    required: ["text"],
    recommended: ["author", "dateCreated"],
  },
  ImageObject: {
    label: "이미지",
    required: ["contentUrl|url"],
    recommended: ["width", "height", "caption"],
  },
  ContactPoint: {
    label: "연락처",
    required: ["telephone", "contactType"],
    recommended: ["email", "availableLanguage"],
  },
  Brand: { label: "브랜드", required: ["name"], recommended: ["url", "logo"] },
  ListItem: {
    label: "목록 항목",
    required: ["position"],
    recommended: ["name", "item"],
  },
  SoftwareApplication: {
    label: "소프트웨어",
    required: ["name"],
    recommended: ["applicationCategory", "operatingSystem", "offers"],
  },
  SearchAction: {
    label: "검색 동작",
    required: ["target"],
    recommended: ["query-input"],
  },
  HowTo: {
    label: "방법",
    required: ["name", "step"],
    recommended: ["description", "image", "totalTime"],
  },
  HowToTool: {
    label: "방법에 필요한 도구",
    required: ["name"],
    recommended: ["image"],
  },
  HowToSupply: {
    label: "방법에 필요한 재료",
    required: ["name"],
    recommended: ["image"],
  },
  SpeakableSpecification: {
    label: "음성 대상",
    required: [],
    recommended: ["cssSelector", "xpath"],
  },
};
export const profileLabels: Record<Profile, string> = {
  corporate: "기업 홈·소개",
  service: "서비스 소개",
  commerce: "상품·커머스",
  article: "블로그·아티클",
  local: "지역 비즈니스",
  faq: "FAQ·Q&A",
};
export const profileOrder = Object.keys(profileLabels) as Profile[];
/** Only common and selected-profile entity types affect the reference score. */
export function scoredTypes(profiles: Profile[]): Set<string> {
  const types = new Set([
    "Organization",
    "LocalBusiness",
    "WebSite",
    "WebPage",
    "BreadcrumbList",
  ]);
  const byProfile: Record<Profile, string[]> = {
    corporate: [],
    service: ["Service"],
    commerce: ["Product", "Offer"],
    article: ["Article", "BlogPosting", "NewsArticle", "Person"],
    local: ["PostalAddress"],
    faq: ["FAQPage", "QAPage", "Question"],
  };
  for (const profile of profiles)
    for (const type of byProfile[profile]) types.add(type);
  return types;
}
export const expectedGroups: Record<
  Profile,
  { id: string; label: string; types: string[] }[]
> = {
  corporate: [],
  service: [
    {
      id: "service",
      label: "서비스(Service) 엔티티",
      types: ["Service"],
    },
  ],
  commerce: [
    { id: "product", label: "상품 엔티티", types: ["Product"] },
    { id: "offer", label: "판매 정보", types: ["Offer"] },
  ],
  article: [
    {
      id: "article",
      label: "아티클 엔티티",
      types: ["Article", "BlogPosting", "NewsArticle"],
    },
    { id: "person", label: "저자", types: ["Person"] },
  ],
  local: [
    { id: "local", label: "지역 비즈니스 엔티티", types: ["LocalBusiness"] },
    { id: "address", label: "주소", types: ["PostalAddress"] },
  ],
  faq: [
    { id: "faq", label: "FAQ·Q&A 엔티티", types: ["FAQPage", "QAPage"] },
    { id: "question", label: "질문", types: ["Question"] },
  ],
};
