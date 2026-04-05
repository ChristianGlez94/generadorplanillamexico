const countries = require("i18n-iso-countries");
const localeEs = require("i18n-iso-countries/langs/es.json");

countries.registerLocale(localeEs);

function cleanLabel(label) {
  return label
    .replace(/\s+/g, " ")
    .replace(/\.$/, "")
    .trim();
}

function buildCountryList() {
  const names = countries.getNames("es", { select: "official" });

  return Object.entries(names)
    .map(([code, name]) => ({
      code,
      name: cleanLabel(name),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "es", { sensitivity: "base" }));
}

const countryList = buildCountryList();

module.exports = {
  countryList,
};
