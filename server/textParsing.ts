export function isAsciiDigit(value: string) {
  const code = value.charCodeAt(0);
  return code >= 48 && code <= 57;
}

export function isAsciiAlpha(value: string) {
  const code = value.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

export function isAsciiAlphaNumeric(value: string) {
  return isAsciiAlpha(value) || isAsciiDigit(value);
}

export function isWhitespace(value: string) {
  const code = value.charCodeAt(0);
  return code === 9 || code === 10 || code === 11 || code === 12 || code === 13 || code === 32;
}

export function isWhitespaceOrControl(value: string) {
  const code = value.charCodeAt(0);
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

export function asnDigitsFromText(value: string) {
  for (let index = 0; index < value.length - 1; index += 1) {
    const previous = index > 0 ? value[index - 1] : undefined;

    if (previous !== undefined && isAsciiAlphaNumeric(previous)) {
      continue;
    }

    if (value[index].toUpperCase() !== "A" || value[index + 1].toUpperCase() !== "S") {
      continue;
    }

    let digitIndex = index + 2;

    while (digitIndex < value.length && isWhitespace(value[digitIndex])) {
      digitIndex += 1;
    }

    const startDigitIndex = digitIndex;

    while (digitIndex < value.length && isAsciiDigit(value[digitIndex])) {
      digitIndex += 1;
    }

    if (digitIndex > startDigitIndex) {
      return value.slice(startDigitIndex, digitIndex);
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
