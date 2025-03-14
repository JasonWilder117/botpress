import { IntegrationLogger } from '@botpress/sdk'
import axios from 'axios'
import { FullPage } from 'src/definitions/actions'
import * as bp from '.botpress'

type FireCrawlResponse = {
  success: boolean
  data: {
    markdown: string
    metadata: {
      ogLocaleAlternate: string[]
      favicon?: string
      title?: string | string[] | null
      description?: string | string[] | null
      sourceURL: string
      pageStatusCode: number
    }
  }
  returnCode: number
}

const COST_PER_PAGE = 0.0015

const fixOutput = (val: unknown): string => {
  if (typeof val === 'string') {
    return val
  } else if (Array.isArray(val)) {
    return val.join(' ')
  }
  return ''
}

const getPageContent = async (props: {
  url: string
  logger: IntegrationLogger
  waitFor?: number
}): Promise<FullPage> => {
  const startTime = Date.now()
  const { data: result } = await axios.post<FireCrawlResponse>(
    'https://api.firecrawl.dev/v1/scrape',
    {
      url: props.url,
      onlyMainContent: true,
      waitFor: props.waitFor,
    },
    {
      headers: {
        Authorization: `Bearer ${bp.secrets.FIRECRAWL_API_KEY}`,
      },
    }
  )

  props.logger.forBot().info(`Browsing ${props.url} took ${Date.now() - startTime}ms`)

  const { metadata, markdown } = result.data

  return {
    url: props.url,
    content: markdown,
    favicon: fixOutput(metadata.favicon),
    title: fixOutput(metadata.title),
    description: fixOutput(metadata.description),
  }
}

export const browsePages: bp.IntegrationProps['actions']['browsePages'] = async ({ input, logger, metadata }) => {
  const startTime = Date.now()

  try {
    const pageContentPromises = await Promise.allSettled(
      input.urls.map((url) => getPageContent({ url, logger, waitFor: input.waitFor }))
    )

    const results = pageContentPromises
      .filter((promise): promise is PromiseFulfilledResult<any> => promise.status === 'fulfilled')
      .map((result) => result.value)

    // only charging for successful pages
    const cost = results.length * COST_PER_PAGE
    metadata.setCost(cost)

    return {
      results,
    }
  } catch (err) {
    logger.forBot().error('There was an error while browsing the page.', err)
    throw err
  } finally {
    logger.forBot().info(`Browsing took ${Date.now() - startTime}ms`)
  }
}
