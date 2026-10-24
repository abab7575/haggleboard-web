export function NeedForm({
  values = {},
}: {
  values?: Partial<Record<"text" | "brand" | "model" | "gender" | "size" | "max_price" | "currency" | "region", string>>;
}) {
  return (
    <form className="panel need-form" action="/results" method="get">
      <label>
        Need
        <textarea
          name="text"
          defaultValue={values.text ?? ""}
          placeholder="women's Brooks Ghost 16, size 8, under $130"
        />
      </label>
      <div className="fields">
        <label>
          Brand
          <input name="brand" defaultValue={values.brand ?? ""} placeholder="Brooks" />
        </label>
        <label>
          Model
          <input name="model" defaultValue={values.model ?? ""} placeholder="Ghost 16" />
        </label>
        <label>
          Gender
          <select name="gender" defaultValue={values.gender ?? ""}>
            <option value="">Any</option>
            <option value="women">Women</option>
            <option value="men">Men</option>
            <option value="unisex">Unisex</option>
            <option value="kids">Kids</option>
          </select>
        </label>
        <label>
          Size
          <input name="size" defaultValue={values.size ?? ""} placeholder="8" />
        </label>
        <label>
          Max price
          <input name="max_price" defaultValue={values.max_price ?? ""} inputMode="decimal" placeholder="130" />
        </label>
        <label>
          Currency
          <select name="currency" defaultValue={values.currency ?? ""}>
            <option value="">Any</option>
            <option>USD</option>
            <option>GBP</option>
            <option>EUR</option>
            <option>CAD</option>
            <option>SGD</option>
          </select>
        </label>
        <label className="span-2">
          Region
          <select name="region" defaultValue={values.region ?? ""}>
            <option value="">Any</option>
            <option value="US">United States</option>
            <option value="UK">United Kingdom</option>
            <option value="IE">Ireland</option>
            <option value="CA">Canada</option>
            <option value="SG">Singapore</option>
          </select>
        </label>
      </div>
      <div className="form-row">
        <p className="hint">Prices stay in each store&apos;s currency. Nothing here is a checkout.</p>
        <button type="submit">Compare listings</button>
      </div>
    </form>
  );
}
