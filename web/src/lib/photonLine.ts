// The Photon iMessage line users text to activate alerts (shared line on the free plan).
export const IMESSAGE_LINE = process.env.NEXT_PUBLIC_IMESSAGE_LINE ?? "+16287896792";

// "+16287896792" -> "(628) 789-6792"
export const IMESSAGE_LINE_DISPLAY = IMESSAGE_LINE.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, "($1) $2-$3");
