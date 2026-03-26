import type { GraphQLClient } from "./graphql.js";

export interface MenuItem {
  id: string;
  name: string;
  displayPrice: string;
  description: string;
  imgUrl: string;
  quickAddEligible: boolean;
  quickAddPrice: number;
  quickAddNestedOptions: string;
}

export interface MenuCategory {
  name: string;
  items: MenuItem[];
}

export interface StoreMenu {
  name: string;
  description: string;
  isConvenience: boolean;
  rating: string;
  deliveryMinutes: number;
  priceRange: string;
  menuId: string;
  address: string;
  coverImgUrl: string;
  categories: MenuCategory[];
}

export interface ConvenienceItem {
  id: string;
  name: string;
  price: string;
  subtext: string;
}

export interface ItemOption {
  id: string;
  name: string;
  price: number;
  displayPrice: string;
  subGroups: ItemOptionGroup[];
}

export interface ItemOptionGroup {
  name: string;
  required: boolean;
  minOptions: number;
  maxOptions: number;
  options: ItemOption[];
}

export interface ItemDetails {
  name: string;
  description: string;
  unitAmount: number;
  imgUrl: string;
  calories: string;
  quantityLimit: number;
  dietaryTags: string[];
  optionGroups: ItemOptionGroup[];
}

export class MenuAPI {
  constructor(private gql: GraphQLClient) {}

  async getStoreMenu(storeId: string): Promise<StoreMenu> {
    const q = this.gql.loadQuery("storepageFeed.graphql");
    const data = await this.gql.query<any>(
      "storepageFeed",
      { storeId, isMerchantPreview: false },
      q,
    );

    const feed = data?.storepageFeed;
    if (!feed) throw new Error("Could not load store page.");

    const header = feed.storeHeader;
    const isConvenience =
      header.isConvenience || (feed.itemLists ?? []).length === 0;

    const categories: MenuCategory[] = [];
    for (const cat of feed.itemLists ?? []) {
      const items: MenuItem[] = [];
      for (const item of cat.items ?? []) {
        items.push({
          id: String(item.id),
          name: item.name,
          displayPrice: item.displayPrice ?? "",
          description: item.description ?? "",
          imgUrl: item.imageUrl ?? "",
          quickAddEligible: !!item.quickAddContext?.isEligible,
          quickAddPrice: item.quickAddContext?.price?.unitAmount ?? 0,
          quickAddNestedOptions: item.quickAddContext?.nestedOptions ?? "[]",
        });
      }
      categories.push({ name: cat.name, items });
    }

    return {
      name: header.name,
      description: header.description ?? "",
      isConvenience,
      rating: header.ratings?.averageRating
        ? `${header.ratings.averageRating}/5 (${header.ratings.numRatingsDisplayString ?? ""})`
        : "",
      deliveryMinutes: header.asapMinutes ?? 0,
      priceRange: header.priceRangeDisplayString ?? "",
      menuId: String(feed.menuBook?.id ?? ""),
      address: header.address
        ? `${header.address.street}, ${header.address.city}, ${header.address.state}`.replace(
            /, $/,
            "",
          )
        : "",
      coverImgUrl: header.coverImgUrl ?? "",
      categories,
    };
  }

  async searchConvenience(
    storeId: string,
    query: string,
  ): Promise<ConvenienceItem[]> {
    const q = this.gql.loadQuery("convenienceSearchQuery.graphql");
    const data = await this.gql.query<any>(
      "convenienceSearchQuery",
      {
        input: {
          query,
          storeId,
          disableSpellCheck: false,
          limit: 15,
          origin: "RETAIL_SEARCH",
          filterQuery: "",
        },
      },
      q,
    );

    const legoItems = data?.retailSearch?.legoRetailItems ?? [];
    return legoItems.map((item: any) => {
      const custom = JSON.parse(item.custom ?? "{}");
      const labels =
        custom.accessibility_information?.accessibility_labels ?? [];
      return {
        name: labels.find((l: any) => l.label === "item_name")?.value ?? "?",
        price: labels.find((l: any) => l.label === "item_price")?.value ?? "?",
        subtext:
          labels.find((l: any) => l.label === "item_subtext")?.value ?? "",
        id: item.id?.match(/:(\d+)$/)?.[1] ?? item.id,
      } as ConvenienceItem;
    });
  }

  async getItemOptions(storeId: string, itemId: string): Promise<ItemDetails> {
    const q = this.gql.loadQuery("itemPage.graphql");
    const data = await this.gql.query<any>(
      "itemPage",
      {
        storeId,
        itemId,
        isMerchantPreview: false,
        isNested: false,
        fulfillmentType: "Delivery",
      },
      q,
    );

    const page = data?.itemPage;
    if (!page) throw new Error("Could not load item details.");

    const header = page.itemHeader;
    const optionGroups: ItemOptionGroup[] = [];

    for (const group of page.optionLists ?? []) {
      optionGroups.push(parseOptionGroup(group));
    }

    return {
      name: header?.name ?? "Item",
      description: header?.description ?? "",
      unitAmount: header?.unitAmount ?? 0,
      imgUrl: header?.imgUrl ?? "",
      calories: header?.caloricInfoDisplayString ?? "",
      quantityLimit: header?.quantityLimit ?? 0,
      dietaryTags: (header?.dietaryTagsList ?? []).map(
        (t: any) => t.fullTagDisplayString,
      ),
      optionGroups,
    };
  }
}

function parseOptionGroup(group: any): ItemOptionGroup {
  return {
    name: group.name,
    required: !group.isOptional,
    minOptions: group.minNumOptions ?? 0,
    maxOptions: group.maxNumOptions ?? 0,
    options: (group.options ?? []).map((opt: any) => ({
      id: String(opt.id),
      name: opt.name,
      price: opt.unitAmount ?? 0,
      displayPrice: opt.displayString ?? "",
      subGroups: (
        opt.nestedExtrasList ??
        opt.optionTagsList ??
        opt.optionLists ??
        []
      ).map((sg: any) => parseOptionGroup(sg)),
    })),
  };
}
