/////////////////////////////
///// Protocol Specific /////
/////////////////////////////

import { Network } from "./constants";

export namespace Protocol {
  export const NAME = "{{ name }}";
  export const SLUG = "{{ slug }}";
  export const PROTOCOL_ADDRESS = "{{ factory.address }}"; // LendingPoolAddressesProvider
  export const NETWORK = Network.TAIKO;
  export const REWARD_TOKEN_ADDRESS = ""; // Protocol token
}
