// The error contract (docs/reference/api.md, "Problem details"): every code a
// client may branch on, with its HTTP status, the title of its problem type
// and the message a client may show, in Arabic and English. Codes are stable
// forever: add one, never rename or reuse one. Messages are written for the
// person using the product, and never quote anything the request carried.

export type Locale = 'ar' | 'en';

type Text = Readonly<Record<Locale, string>>;

interface Problem {
  readonly status: number;
  readonly title: string;
  readonly message: Text;
}

export const PROBLEMS = {
  VALIDATION_FAILED: {
    status: 400,
    title: 'Validation failed',
    message: {
      en: 'Check the highlighted fields.',
      ar: 'تحقّق من الحقول المحدّدة.',
    },
  },
  INVALID_CURSOR: {
    status: 400,
    title: 'Invalid cursor',
    message: {
      en: 'This list link has expired. Start again from the first page.',
      ar: 'انتهت صلاحية رابط هذه القائمة. ابدأ من الصفحة الأولى.',
    },
  },
  AUTHENTICATION_REQUIRED: {
    status: 401,
    title: 'Authentication required',
    message: {
      en: 'Sign in to continue.',
      ar: 'سجّل الدخول للمتابعة.',
    },
  },
  SESSION_EXPIRED: {
    status: 401,
    title: 'Session expired',
    message: {
      en: 'Your session has ended. Sign in again.',
      ar: 'انتهت جلستك. سجّل الدخول من جديد.',
    },
  },
  FORBIDDEN: {
    status: 403,
    title: 'Forbidden',
    message: {
      en: "You don't have permission to do this.",
      ar: 'ليست لديك صلاحية القيام بهذا.',
    },
  },
  CSRF_FAILED: {
    status: 403,
    title: 'Request not verified',
    message: {
      en: "This request couldn't be verified. Reload the page and try again.",
      ar: 'تعذّر التحقق من هذا الطلب. أعد تحميل الصفحة وحاول مرة أخرى.',
    },
  },
  STEP_UP_REQUIRED: {
    status: 403,
    title: 'Step-up required',
    message: {
      en: "Confirm it's you to continue.",
      ar: 'أكّد هويتك للمتابعة.',
    },
  },
  NOT_FOUND: {
    status: 404,
    title: 'Not found',
    message: {
      en: "We couldn't find what you're looking for.",
      ar: 'لم نجد ما تبحث عنه.',
    },
  },
  CONFLICT: {
    status: 409,
    title: 'Conflict',
    message: {
      en: 'This conflicts with existing data. Reload and try again.',
      ar: 'يتعارض هذا مع بيانات موجودة. أعد التحميل وحاول مرة أخرى.',
    },
  },
  INVALID_TRANSITION: {
    status: 409,
    title: 'Invalid transition',
    message: {
      en: "This action isn't available in the current state.",
      ar: 'هذا الإجراء غير متاح في الحالة الحالية.',
    },
  },
  IDEMPOTENCY_IN_PROGRESS: {
    status: 409,
    title: 'Request in progress',
    message: {
      en: 'This request is still being processed.',
      ar: 'ما زال هذا الطلب قيد المعالجة.',
    },
  },
  IDEMPOTENCY_KEY_REUSED: {
    status: 409,
    title: 'Idempotency key reused',
    message: {
      en: 'This request key was already used for a different request.',
      ar: 'استُخدم مفتاح هذا الطلب من قبل لطلب مختلف.',
    },
  },
  REVISION_MISMATCH: {
    status: 412,
    title: 'Revision mismatch',
    message: {
      en: 'Someone else changed this. Reload to see the latest version.',
      ar: 'عدّل شخص آخر هذا العنصر. أعد التحميل لترى أحدث نسخة.',
    },
  },
  PAYLOAD_TOO_LARGE: {
    status: 413,
    title: 'Payload too large',
    message: {
      en: 'The request is too large.',
      ar: 'الطلب أكبر من الحجم المسموح.',
    },
  },
  UNSUPPORTED_MEDIA_TYPE: {
    status: 415,
    title: 'Unsupported media type',
    message: {
      en: "This type of content isn't accepted.",
      ar: 'هذا النوع من المحتوى غير مقبول.',
    },
  },
  PRECONDITION_REQUIRED: {
    status: 428,
    title: 'Precondition required',
    message: {
      en: "This change needs the version you're editing. Reload and try again.",
      ar: 'يتطلب هذا التعديل النسخة التي تعمل عليها. أعد التحميل وحاول مرة أخرى.',
    },
  },
  RATE_LIMITED: {
    status: 429,
    title: 'Rate limited',
    message: {
      en: 'Too many requests. Wait a moment and try again.',
      ar: 'طلبات كثيرة جدًا. انتظر قليلًا ثم حاول مرة أخرى.',
    },
  },
  INTERNAL_ERROR: {
    status: 500,
    title: 'Internal error',
    message: {
      en: 'Something went wrong on our side. Try again, and if it keeps happening, quote the request ID.',
      ar: 'حدث خطأ من جهتنا. حاول مرة أخرى، وإن تكرّر فاذكر معرّف الطلب.',
    },
  },
  DEPENDENCY_UNAVAILABLE: {
    status: 503,
    title: 'Dependency unavailable',
    message: {
      en: 'The service is temporarily unavailable. Try again shortly.',
      ar: 'الخدمة غير متاحة مؤقتًا. حاول مرة أخرى بعد قليل.',
    },
  },
} as const satisfies Record<string, Problem>;

export type ErrorCode = keyof typeof PROBLEMS;

// What can be wrong with one field. Stable forever, like the codes above.
export const FIELD_PROBLEMS = {
  REQUIRED: {
    en: 'Fill in this field.',
    ar: 'املأ هذا الحقل.',
  },
  INVALID_TYPE: {
    en: 'Enter a value of the right type.',
    ar: 'أدخل قيمة من النوع الصحيح.',
  },
  INVALID_FORMAT: {
    en: 'Check the format of this value.',
    ar: 'تحقّق من صيغة هذه القيمة.',
  },
  INVALID_VALUE: {
    en: 'Choose an allowed value.',
    ar: 'اختر قيمة مسموحًا بها.',
  },
  TOO_SMALL: {
    en: 'This is too short or too small.',
    ar: 'هذه القيمة أقصر أو أصغر من المسموح.',
  },
  TOO_BIG: {
    en: 'This is too long or too large.',
    ar: 'هذه القيمة أطول أو أكبر من المسموح.',
  },
  OUT_OF_RANGE: {
    en: 'This value is outside the allowed range.',
    ar: 'هذه القيمة خارج النطاق المسموح.',
  },
  UNKNOWN_FIELD: {
    en: "This field isn't accepted here.",
    ar: 'هذا الحقل غير مقبول هنا.',
  },
} as const satisfies Record<string, Text>;

export type FieldErrorCode = keyof typeof FIELD_PROBLEMS;

export function isFieldErrorCode(value: string): value is FieldErrorCode {
  return Object.hasOwn(FIELD_PROBLEMS, value);
}

/** The stable URI of a code's problem type: `urn:sadara:problem:not-found`. */
export function problemTypeOf(code: ErrorCode): string {
  return `urn:sadara:problem:${code.toLowerCase().replaceAll('_', '-')}`;
}
