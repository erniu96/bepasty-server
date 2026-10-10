from selenium.webdriver import Firefox
from selenium.webdriver.chrome.service import Service as ChromeService
from selenium.webdriver import Chrome
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.common.by import By
from selenium.common.exceptions import NoSuchDriverException

import os
import pytest

import time


@pytest.mark.needs_server
class TestMaxlifeFeature:
    """
    Checks if the maxlife feature is working.
    """

    def setup_class(self):
        """
        Setup: Open the passwordless upload page on its LAN address.
        """
        try:
            self.browser = Firefox()
        except NoSuchDriverException:
            service = ChromeService(executable_path="/usr/bin/chromedriver")
            self.browser = Chrome(service=service)
        self.base_url = os.environ.get('BEPASTY_TEST_URL', 'http://10.10.10.222:5000/')
        self.browser.get(self.base_url)
        self.browser.find_element(By.ID, "fileupload")

    def teardown_class(self):
        """
        Teardown: Close the browser.
        """
        self.browser.quit()

    @property
    def page_body_lowercase(self):
        return self.browser.find_element(By.TAG_NAME, "body").text.lower()

    def test_unit_input_exists(self):
        self.browser.get(self.base_url)
        preset = self.browser.find_element(By.ID, "upload-maxlife-preset")
        assert preset.is_displayed()

    def fill_form(self, lifetime_unit='forever'):
        """
        Fills test values into the form and submits it.
        :return: tuple(filename, pasted_text)
        """
        filename = "test.txt"
        text_to_paste = "This is a test"
        self.browser.get(self.base_url)
        paste_input = self.browser.find_element(By.ID, "formupload")
        paste_input.send_keys(text_to_paste)
        filename_input = self.browser.find_element(By.ID, "filename")
        filename_input.send_keys(filename)
        contenttype_input = self.browser.find_element(By.ID, "contenttype")
        contenttype_input.send_keys("text/plain")
        contenttype_input.send_keys(Keys.ESCAPE)
        selector = '#text-maxlife-preset option[value="' + lifetime_unit + ':1"]'
        self.browser.find_element(By.CSS_SELECTOR, selector).click()
        self.browser.find_element(By.ID, "formupload-submit").click()
        time.sleep(.2)  # give some time to render the next view
        return filename, text_to_paste

    def delete_current_file(self):
        self.browser.find_element(By.ID, "del-btn").click()
        time.sleep(.2)

    def test_paste_keep_forever(self):
        self.fill_form(lifetime_unit='forever')
        assert "永久保留" in self.page_body_lowercase
        self.delete_current_file()

    def test_paste_keep_minutes(self):
        self.fill_form(lifetime_unit='minutes')
        assert "永久保留" not in self.page_body_lowercase
        self.delete_current_file()

    def test_filename_gets_displayed(self):
        filename, _ = self.fill_form()
        assert filename.lower() in self.page_body_lowercase
        self.delete_current_file()

    def test_pasted_text_gets_displayed(self):
        _, pasted_text = self.fill_form()
        self.browser.find_element(By.ID, "inline-btn").click()
        assert pasted_text.lower() in self.page_body_lowercase
        self.browser.back()
        self.delete_current_file()

    @pytest.mark.slow
    def test_file_gets_deleted_after_expiry_time(self):
        self.fill_form(lifetime_unit='minutes')
        time.sleep(61)
        self.browser.find_element(By.ID, "inline-btn").click()
        assert "不存在" in self.page_body_lowercase
