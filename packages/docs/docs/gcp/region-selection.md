---
image: /generated/articles-docs-gcp-region-selection.png
id: region-selection
title: Region selection
slug: /gcp/region-selection
crumb: "GCP"
---

import {GcpRegionList} from '../../components/gcp/regions.tsx';

Before going live with Remotion Cloud Run, you need to think about into which GCP region you are deploying your service and bucket.

This document explains how to select a region and which considerations you need to make.

## Available regions

The following GCP regions are available:

<GcpRegionList />

You can call [`getRegions()`](/docs/gcp/getregions) or type [`npx remotion gcp regions`](/docs/gcp/cli/regions) to get this list programmatically.

## Default region

The default region is `us-east1`.

## Selecting a region

There are 3 ways of selection a region:

- When using the Node.JS APIs, you have to pass the region explicitly to each function. Make sure your projects satisfy the Typescript types or follow the documentation.

- When using the CLI, you can set the region using the `REMOTION_GCP_REGION` environment variable. It's best to put it in a `.env` file so you don't forget it sometimes.

- You can also pass the `--region` flag to all CLI commands to override the region. The flag takes precedence over the environment variable.

:::info
The REMOTION_GCP_REGION environment variable and `--region` flag do not have an effect when using the Node.JS APIs. You need to pass a region explicitly.
:::

If you don't set a region, Remotion will use the default region.

## Which region should I choose?

Note that each region falls into one of two different pricing tiers. Some regions also offer low CO<sub>2</sub> intensity electricity usage. The full list of regions per tier is available in the [Cloud Run Docs](https://cloud.google.com/run/docs/locations).

## Other considerations

- The Cloud Run service and Cloud Storage bucket must be in the same region to eliminate latency across datacenters.