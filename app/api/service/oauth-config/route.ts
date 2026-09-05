import { NextRequest, NextResponse } from "next/server";
import { getBaseUrl } from "@/lib/env";
import { isServiceApiEnabled, serviceTokenMatches } from "@/lib/service-auth";

/**
 * What the OAuth round trip actually uses, without revealing secrets.
 *
 * "Error validating verification code. Please make sure your redirect_uri is
 * identical to the one you used in the OAuth dialog request" is Meta's generic
 * failure for the token exchange. It covers an unregistered redirect URI, a
 * wrong app secret, a reused code and an expired code, and says nothing about
 * which one happened. Diagnosing it from outside means guessing, and each
 * guess costs a deploy and a manual login attempt.
 *
 * The redirect URI is derived here exactly the way both sides derive it, so
 * the value returned is the value Meta receives, including a trailing slash
 * or a wrong host that nobody would notice by reading the env var.
 *
 * Secrets are reported by shape only: present, length, and whether they carry
 * surrounding whitespace. A secret pasted from a truncated console field is
 * the other common cause, and its length gives it away without exposing it.
 */
export async function GET(req: NextRequest) {
  if (!isServiceApiEnabled()) {
    return NextResponse.json(
      { success: false, error: "Service API disabled" },
      { status: 503 },
    );
  }

  if (!serviceTokenMatches(req.headers.get("authorization"))) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const base = getBaseUrl();
  const redirectUri = `${base}/api/instagram/callback`;

  const forma = (nome: string) => {
    const bruto = process.env[nome];
    if (!bruto) return { presente: false };
    return {
      presente: true,
      tamanho: bruto.length,
      // Espaço em volta sobrevive ao copiar e cola e quebra a comparação do
      // outro lado sem aparecer em lugar nenhum.
      comEspacoEmVolta: bruto !== bruto.trim(),
      // Placeholder esquecido tem cara de valor preenchido numa tela de env.
      pareceMarcador: /pendente|replace|your-|todo|xxx/i.test(bruto),
      primeiros4: bruto.trim().slice(0, 4),
    };
  };

  return NextResponse.json({
    success: true,
    baseUrl: base,
    redirectUri,
    // Barra dupla passa despercebida e faz a comparação da Meta falhar.
    barraDuplicada: redirectUri.includes("//api/"),
    envs: {
      NEXTAUTH_URL: forma("NEXTAUTH_URL"),
      INSTAGRAM_APP_ID: forma("INSTAGRAM_APP_ID"),
      INSTAGRAM_APP_SECRET: forma("INSTAGRAM_APP_SECRET"),
      FACEBOOK_APP_SECRET: forma("FACEBOOK_APP_SECRET"),
      WEBHOOK_VERIFY_TOKEN: forma("WEBHOOK_VERIFY_TOKEN"),
    },
  });
}
