import { SmitheryRegistry } from "@smithery/registry";
import { ServerListItem, Pagination } from "@smithery/registry/models/components";
import { 
  Card, 
  CardContent, 
  CardDescription, 
  CardFooter, 
  CardHeader, 
  CardTitle 
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

// Types are now directly imported, so these aliases point to the imported types
// type ServerListItem = ServerListItem; // This line is redundant now
// type PaginationInfo = Pagination; // This line is redundant now

async function getServerListData(): Promise<{
  servers: ServerListItem[];
  pagination: Pagination | null;
  error?: string;
}> {
  const smitheryRegistry = new SmitheryRegistry({
    bearerAuth: process.env.SMITHERY_BEARER_AUTH ?? "",
  });

  const allServers: ServerListItem[] = [];
  let firstPagePaginationInfo: Pagination | null = null;

  try {
    // Fetch the first page
    const firstPageResultIterator = await smitheryRegistry.servers.list({ page: 1 });
    let pagesFetched = 0;

    for await (const pageResponse of firstPageResultIterator) {
      pagesFetched++;
      if (pageResponse.result) {
        if (!firstPagePaginationInfo && pageResponse.result.pagination) {
          firstPagePaginationInfo = pageResponse.result.pagination;
        }
        if (pageResponse.result.servers && Array.isArray(pageResponse.result.servers)) {
          allServers.push(...pageResponse.result.servers);
        }
      }
      // If the iterator only gives one page, this loop only runs once.
      // We will rely on totalPages from firstPagePaginationInfo to fetch the rest.
      if (pagesFetched === 1) break; // Ensure we only process the first page from this initial iterator
    }

    if (!firstPagePaginationInfo) {
      // If we couldn't get pagination info from the first call (e.g., no servers at all)
      // or if the iterator didn't even yield one page.
      if (allServers.length === 0 && pagesFetched === 0) {
         // Attempt to get at least one page if the iterator yielded nothing initially
         // This could happen if the iterator from .list({}) is empty but there are pages
        const directFirstPage = await smitheryRegistry.servers.list({ page: 1 });
        const firstPageData = await directFirstPage[Symbol.asyncIterator]().next();
        if (firstPageData && !firstPageData.done && firstPageData.value.result) {
            if(firstPageData.value.result.pagination) firstPagePaginationInfo = firstPageData.value.result.pagination;
            if(firstPageData.value.result.servers) allServers.push(...firstPageData.value.result.servers);
        }
      }
       // If still no pagination info and no servers, return what we have (likely empty or error)
      if (!firstPagePaginationInfo && allServers.length === 0) {
        return { servers: [], pagination: null, error: pagesFetched === 0 ? "Failed to fetch initial page data." : undefined };
      }
    }
    
    // If there are more pages, fetch them manually
    if (firstPagePaginationInfo && firstPagePaginationInfo.totalPages && firstPagePaginationInfo.totalPages > 1) {
      const pageSize = firstPagePaginationInfo.pageSize || 10; // Default pageSize if not in pagination
      const totalPagesToConsider = firstPagePaginationInfo.totalPages;
      // TEMPORARY TEST: Limit total pages fetched to, e.g., 5 (page 1 already fetched, so loop up to 5)
      const maxPageToLoopTo = Math.min(totalPagesToConsider, 5);
      console.log(`Attempting to fetch pages 2 through ${maxPageToLoopTo} of ${totalPagesToConsider} total pages.`);

      for (let i = 2; i <= maxPageToLoopTo; i++) {
        try {
          console.log(`Fetching page ${i}...`);
          const nextPageResultIterator = await smitheryRegistry.servers.list({ page: i, pageSize });
          // The iterator should yield one page here as we are requesting a specific page
          const pageData = await nextPageResultIterator[Symbol.asyncIterator]().next();
          if (pageData && !pageData.done && pageData.value.result && pageData.value.result.servers) {
            allServers.push(...pageData.value.result.servers);
          }
        } catch (loopError: any) {
          console.error(`Error fetching page ${i}:`, loopError);
          // Optionally, you could decide to return partial data or a more specific error
          // For now, we'll let the main try-catch handle a general error if this becomes critical
        }
      }
    }

    return { servers: allServers, pagination: firstPagePaginationInfo };
  } catch (error: any) {
    console.error("Error fetching from Smithery Registry:", error);
    return { servers: [], pagination: firstPagePaginationInfo, error: `Failed to fetch servers: ${error.message}` };
  }
}

export default async function RegistryServersPage() {
  const { servers, pagination, error } = await getServerListData();

  if (error) {
    return (
      <div className="container mx-auto p-4">
        <h1 className="text-2xl font-bold mb-4">Error Fetching Servers</h1>
        <p className="text-red-500">{error}</p>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-4">
      <header className="mb-8">
        <h1 className="text-3xl font-bold mb-2">Smithery Registry Servers</h1>
        {pagination && (
          <p className="text-muted-foreground">
            Displaying {servers.length} servers.
            {pagination.totalCount && ` Total ${pagination.totalCount} servers found`}
            {pagination.totalPages && pagination.totalCount && pagination.totalCount > 0 && 
             (servers.length === pagination.totalCount ? 
               ` (all ${pagination.totalPages} pages fetched and displayed).` : 
               ` (fetched ${servers.length} of ${pagination.totalCount} across ${pagination.totalPages} pages).`
             )
            }
          </p>
        )}
      </header>

      {(!servers || servers.length === 0) && !error && (
        <p>No servers found.</p>
      )}

      {servers && servers.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {servers.map((server) => (
            <Card key={server.qualifiedName} className="flex flex-col">
              <CardHeader>
                <CardTitle>{server.displayName}</CardTitle>
                <CardDescription>{server.qualifiedName}</CardDescription>
              </CardHeader>
              <CardContent className="flex-grow">
                <p className="text-sm text-muted-foreground mb-4">
                  {server.description}
                </p>
                <div className="text-xs text-muted-foreground">
                  Created: {new Date(server.createdAt).toLocaleDateString()}
                </div>
              </CardContent>
              <CardFooter className="flex justify-between items-center">
                <a 
                  href={server.homepage} 
                  target="_blank" 
                  rel="noopener noreferrer" 
                  className="text-sm text-blue-500 hover:underline"
                >
                  Homepage
                </a>
                <Badge variant="secondary">Uses: {server.useCount.toLocaleString()}</Badge>
              </CardFooter>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
} 