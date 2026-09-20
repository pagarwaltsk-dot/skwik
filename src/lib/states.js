// State code -> name. The first two digits of a GSTIN are the state code.
export const STATES = {
  '01':'Jammu and Kashmir','02':'Himachal Pradesh','03':'Punjab','04':'Chandigarh','05':'Uttarakhand',
  '06':'Haryana','07':'Delhi','08':'Rajasthan','09':'Uttar Pradesh','10':'Bihar','11':'Sikkim',
  '12':'Arunachal Pradesh','13':'Nagaland','14':'Manipur','15':'Mizoram','16':'Tripura','17':'Meghalaya',
  '18':'Assam','19':'West Bengal','20':'Jharkhand','21':'Odisha','22':'Chhattisgarh','23':'Madhya Pradesh',
  '24':'Gujarat','25':'Daman and Diu','26':'Dadra and Nagar Haveli','27':'Maharashtra','29':'Karnataka',
  '30':'Goa','31':'Lakshadweep','32':'Kerala','33':'Tamil Nadu','34':'Puducherry','35':'Andaman and Nicobar',
  '36':'Telangana','37':'Andhra Pradesh','38':'Ladakh',
};
export const stateOf = (gstin) => STATES[String(gstin || '').slice(0, 2)] || '';

// The other way round: a state NAME back to its code.
//
// A customer list imported from a spreadsheet usually names the state and has
// no GST number to take the code from. Without this, an out-of-state customer
// arrived with no code at all and was given the shop's own — which quietly
// turned every sale to him into a local sale and charged the wrong tax.
const BY_NAME = Object.fromEntries(
  Object.entries(STATES).map(([code, name]) => [name.toLowerCase().replace(/[^a-z]/g, ''), code]));

// A few of the ways people actually write them.
const ALIASES = {
  orissa: '21', pondicherry: '34', uttaranchal: '05', newdelhi: '07',
  nctofdelhi: '07', delhinct: '07', jandk: '01', jk: '01',
  tn: '33', ap: '37', up: '09', mp: '23', wb: '19', ts: '36',
  andamanandnicobarislands: '35', dadraandnagarhavelianddamananddiu: '26',
};

export const codeForState = (name) => {
  const k = String(name || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!k) return '';
  return BY_NAME[k] || ALIASES[k] || '';
};
