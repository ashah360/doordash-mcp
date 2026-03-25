import type { GraphQLClient } from "./graphql.js";

export interface StoreResult {
  name: string;
  storeId: string;
  distance: string;
  cuisine: string;
}

export class SearchAPI {
  constructor(private gql: GraphQLClient) {}

  async searchStores(query: string): Promise<StoreResult[]> {
    const q = this.gql.loadQuery("autocompleteFacetFeed.graphql");
    const data = await this.gql.query<any>("autocompleteFacetFeed", { query }, q);

    const items = data?.autocompleteFacetFeed?.body?.[0]?.body ?? [];
    return items
      .map((item: any) => {
        const name = item.text?.title;
        const dist = item.text?.subtitle ?? "";
        const cuisine = item.text?.description ?? "";
        const clickData = JSON.parse(item.events?.click?.data ?? "{}");
        const storeId = clickData.uri?.match(/store\/(\d+)/)?.[1];
        if (!name || !storeId) return null;
        return { name, storeId, distance: dist, cuisine } as StoreResult;
      })
      .filter(Boolean) as StoreResult[];
  }
}
