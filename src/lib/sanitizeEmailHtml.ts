import DOMPurify from "dompurify";

/**
 * Sanitize HTML for safe rendering in admin email previews.
 * Allows tags/attributes common to transactional emails but strips
 * <script>, inline event handlers, and javascript:/data: URIs.
 */
export const sanitizeEmailHtml = (html: string): string =>
  DOMPurify.sanitize(html || "", {
    ALLOWED_TAGS: [
      "a", "b", "blockquote", "br", "code", "div", "em", "h1", "h2", "h3",
      "h4", "h5", "h6", "hr", "i", "img", "li", "ol", "p", "pre", "s",
      "small", "span", "strike", "strong", "sub", "sup", "table", "tbody",
      "td", "tfoot", "th", "thead", "tr", "u", "ul", "center", "font",
      "figure", "figcaption",
    ],
    ALLOWED_ATTR: [
      "href", "target", "rel", "src", "alt", "title", "width", "height",
      "align", "valign", "border", "cellpadding", "cellspacing", "bgcolor",
      "color", "face", "size", "class", "style", "colspan", "rowspan",
    ],
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|cid:|#|\/)/i,
  });
