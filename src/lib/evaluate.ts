function evaluateNumericExpression(expr: string): number {
  const scope = {
    sin: Math.sin,
    cos: Math.cos,
    tan: Math.tan,
    log: Math.log10,
    ln: Math.log,
    sqrt: Math.sqrt,
    abs: Math.abs,
    pow: Math.pow,
    pi: Math.PI,
  };
  const sanitized = expr
    .replace(/\bpi\b/g, "scope.pi")
    .replace(/\bsin\s*\(/g, "scope.sin(")
    .replace(/\bcos\s*\(/g, "scope.cos(")
    .replace(/\btan\s*\(/g, "scope.tan(")
    .replace(/\blog\s*\(/g, "scope.log(")
    .replace(/\bln\s*\(/g, "scope.ln(")
    .replace(/\bsqrt\s*\(/g, "scope.sqrt(")
    .replace(/\babs\s*\(/g, "scope.abs(")
    .replace(/\^/g, "**");

  if (!/^[\d+\-*/().,\s*scopeincotalgqrpbw]+$/i.test(sanitized)) {
    throw new Error("Expression contains unsupported characters");
  }

  const result = Function("scope", `"use strict"; return (${sanitized});`)(scope);
  if (typeof result !== "number") throw new Error("Invalid expression");
  return result;
}

export function safeEvaluate(expr: string, angleMode: "deg" | "rad"): { value: number | null; error: string | null } {
  try {
    let sanitized = expr
      .replace(/×/g, "*")
      .replace(/÷/g, "/")
      .replace(/π/g, "pi")
      .replace(/e(?![xp])/g, "2.718281828459045")
      .replace(/(\d+(?:\.\d+)?)%/g, "($1/100)");

    if (angleMode === "deg") {
      sanitized = sanitized
        .replace(/\bsin\(([^()]+)\)/g, "sin(($1)*pi/180)")
        .replace(/\bcos\(([^()]+)\)/g, "cos(($1)*pi/180)")
        .replace(/\btan\(([^()]+)\)/g, "tan(($1)*pi/180)");
    }

    const result = evaluateNumericExpression(sanitized);

    if (typeof result !== "number") {
      return { value: null, error: "Invalid expression" };
    }

    if (!isFinite(result)) {
      return { value: result, error: null };
    }

    return { value: result, error: null };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Error";
    return { value: null, error: message };
  }
}

export function evaluateSingleFn(fn: string, operand: number, angleMode: "deg" | "rad"): { value: number | null; error: string | null } {
  try {
    let result: number;

    switch (fn) {
      case "sin": {
        const rad = angleMode === "deg" ? (operand * Math.PI) / 180 : operand;
        result = Math.sin(rad);
        break;
      }
      case "cos": {
        const rad = angleMode === "deg" ? (operand * Math.PI) / 180 : operand;
        result = Math.cos(rad);
        break;
      }
      case "tan": {
        const rad = angleMode === "deg" ? (operand * Math.PI) / 180 : operand;
        result = Math.tan(rad);
        break;
      }
      case "log":
        result = Math.log10(operand);
        break;
      case "ln":
        result = Math.log(operand);
        break;
      case "sqrt":
        result = Math.sqrt(operand);
        break;
      case "square":
        result = operand * operand;
        break;
      case "cube":
        result = operand * operand * operand;
        break;
      case "reciprocal":
        result = 1 / operand;
        break;
      case "factorial": {
        if (operand < 0 || !Number.isInteger(operand)) {
          return { value: null, error: "Factorial requires non-negative integer" };
        }
        result = factorial(Math.floor(operand));
        break;
      }
      case "percent":
        result = operand / 100;
        break;
      default:
        return { value: null, error: `Unknown function: ${fn}` };
    }

    if (!isFinite(result)) {
      return { value: result, error: null };
    }

    return { value: result, error: null };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Error";
    return { value: null, error: message };
  }
}

export function factorial(n: number): number {
  if (n <= 1) return 1;
  return n * factorial(n - 1);
}
