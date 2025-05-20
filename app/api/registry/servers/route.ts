import { SmitheryRegistry } from "@smithery/registry";
import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const smitheryRegistry = new SmitheryRegistry({
    bearerAuth: process.env.SMITHERY_BEARER_AUTH ?? "",
  });

  const { searchParams } = new URL(request.url);
  const q = searchParams.get("q") || undefined; // Or a default query

  try {
    const result = await smitheryRegistry.servers.list({ q });
    
    // The result is an async iterator, so we need to collect the pages.
    // Note: Depending on the expected size of the result, 
    // you might want to stream this or handle pagination differently.
    const allPages = [];
    for await (const page of result) {
      allPages.push(page);
    }

    return NextResponse.json(allPages);
  } catch (error: any) {
    console.error("Error fetching from Smithery Registry:", error);
    return NextResponse.json(
      { error: "Failed to fetch from registry", details: error.message },
      { status: 500 }
    );
  }
} 