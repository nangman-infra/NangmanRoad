export function isAsciiDigit(value: string) {
  const code = value.codePointAt(0) ?? -1;
  return code >= 48 && code <= 57;
}

export function isAsciiAlpha(value: string) {
  const code = value.codePointAt(0) ?? -1;
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

export function isAsciiAlphaNumeric(value: string) {
  return isAsciiAlpha(value) || isAsciiDigit(value);
}

export function isWhitespace(value: string) {
  const code = value.codePointAt(0) ?? -1;
  return code === 9 || code === 10 || code === 11 || code === 12 || code === 13 || code === 32;
}

export function isWhitespaceOrControl(value: string) {
  const code = value.codePointAt(0) ?? -1;
  return code <= 32 || code === 127;
}

export function splitBySeparator(value: string, isSeparator: (character: string) => boolean) {
  const tokens: string[] = [];
  let startIndex: number | undefined;

  for (let index = 0; index <= value.length; index += 1) {
    const character = value[index];

    if (character !== undefined && !isSeparator(character)) {
      startIndex ??= index;
      continue;
    }

    if (startIndex !== undefined) {
      tokens.push(value.slice(startIndex, index));
      startIndex = undefined;
    }
  }

  return tokens;
}

export function splitWhitespace(value: string) {
  return splitBySeparator(value, isWhitespace);
}

export function isDigitsOnly(value: string, maxLength: number) {
  if (value.length === 0 || value.length > maxLength) {
    return false;
  }

  for (const character of value) {
    if (!isAsciiDigit(character)) {
      return false;
    }
  }

  return true;
}

export function isDecimalToken(value: string) {
  if (!value) {
    return false;
  }

  let decimalPoints = 0;
  let digits = 0;

  for (const character of value) {
    if (isAsciiDigit(character)) {
      digits += 1;
      continue;
    }

    if (character === "." && decimalPoints === 0) {
      decimalPoints += 1;
      continue;
    }

    return false;
  }

  return digits > 0;
}

function isAsPrefixAt(value: string, index: number) {
  const previous = index > 0 ? value[index - 1] : undefined;

  return (
    (previous === undefined || !isAsciiAlphaNumeric(previous)) &&
    value[index].toUpperCase() === "A" &&
    value[index + 1].toUpperCase() === "S"
  );
}

function firstAsnDigitIndex(value: string, prefixIndex: number) {
  let digitIndex = prefixIndex + 2;

  while (digitIndex < value.length && isWhitespace(value[digitIndex])) {
    digitIndex += 1;
  }

  return digitIndex;
}

function firstNonDigitIndex(value: string, digitIndex: number) {
  let endIndex = digitIndex;

  while (endIndex < value.length && isAsciiDigit(value[endIndex])) {
    endIndex += 1;
  }

  return endIndex;
}

export function asnDigitsFromText(value: string) {
  for (let index = 0; index < value.length - 1; index += 1) {
    if (!isAsPrefixAt(value, index)) {
      continue;
    }

    const startDigitIndex = firstAsnDigitIndex(value, index);
    const endDigitIndex = firstNonDigitIndex(value, startDigitIndex);

    if (endDigitIndex > startDigitIndex) {
      return value.slice(startDigitIndex, endDigitIndex);
    }
  }

  return undefined;
}

export function compactWhitespace(value: string) {
  let compacted = "";

  for (const character of value) {
    if (!isWhitespace(character)) {
      compacted += character;
    }
  }

  return compacted;
}
